import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * Fase ABC.0 — clasificación ABC por (almacén, producto). Ver FASE_ABC_CYCLE_COUNT.md.
 *
 * Métrica = valor de consumo anualizado: unidades vendidas (líneas de pedidos
 * `fulfilled` en una ventana trailing → anualizadas) × costo unitario (catalog.cost_base).
 * Pareto POR ALMACÉN: A = hasta 80% del valor acumulado · B = 80–95% · C = resto
 * (y todo lo sin ventas). Tenant-local, per-almacén, no depende del sync ERP.
 *
 * Recompute full atómico (DELETE+INSERT en la misma trx) → sin ventana vacía.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_WINDOW_DAYS = 90;
/** ABC.1 — cadencia de conteo cíclico por clase (días). Configurable por tenant = ABC.4. */
const CADENCE_DAYS = { A: 30, B: 90, C: 365 };

@Injectable()
export class InventoryAbcService {
  private readonly logger = new Logger(InventoryAbcService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Recomputa la clasificación ABC del tenant (todos los almacenes). */
  async computeAbc(opts: { window_days?: number } = {}) {
    const windowDays = Number.isFinite(Number(opts.window_days))
      ? Math.min(365, Math.max(7, Math.floor(Number(opts.window_days))))
      : DEFAULT_WINDOW_DAYS;

    return this.tk.run(async (trx) => {
      await trx.raw('DELETE FROM commercial.abc_classification'); // RLS-scoped al tenant

      const inserted = await trx.raw(
        `
        INSERT INTO commercial.abc_classification
          (tenant_id, warehouse_id, product_id, abc_class, annual_value, units_window, value_share, window_days, computed_at)
        WITH sales AS (
          SELECT o.warehouse_id, l.product_id, SUM(l.quantity)::numeric AS units
            FROM commercial.orders o
            JOIN commercial.order_lines l ON l.order_id = o.id
           WHERE o.status = 'fulfilled' AND o.fulfilled_at >= now() - (? || ' days')::interval
           GROUP BY o.warehouse_id, l.product_id
        ),
        base AS (
          SELECT s.warehouse_id, s.product_id,
                 COALESCE(sa.units, 0) AS units,
                 (COALESCE(sa.units, 0) * (365.0 / ?) * COALESCE(cp.cost_base, 0))::numeric(16,2) AS annual_value
            FROM commercial.stock s
            JOIN catalog.products cp ON cp.id = s.product_id
            LEFT JOIN sales sa ON sa.warehouse_id = s.warehouse_id AND sa.product_id = s.product_id
        ),
        ranked AS (
          SELECT warehouse_id, product_id, units, annual_value,
                 SUM(annual_value) OVER (PARTITION BY warehouse_id ORDER BY annual_value DESC, product_id
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_value,
                 NULLIF(SUM(annual_value) OVER (PARTITION BY warehouse_id), 0) AS total_value
            FROM base
        )
        SELECT public.current_tenant_id(), warehouse_id, product_id,
               -- Pareto por share ACUMULADO EXCLUSIVO (el de los items anteriores): el
               -- top siempre cae en A; el item que cruza 80% es el último A. Inclusivo
               -- mandaría a C al único mover de un almacén (cum=100%).
               CASE WHEN total_value IS NULL THEN 'C'
                    WHEN (cum_value - annual_value) / total_value < 0.80 THEN 'A'
                    WHEN (cum_value - annual_value) / total_value < 0.95 THEN 'B'
                    ELSE 'C' END,
               annual_value,
               units,
               CASE WHEN total_value IS NULL THEN 1.0 ELSE round(cum_value / total_value, 4) END,
               ?::int,
               now()
          FROM ranked
        `,
        [windowDays, windowDays, windowDays],
      );

      const summary = await trx('commercial.abc_classification')
        .select('abc_class')
        .count<{ abc_class: string; n: string }[]>('* as n')
        .sum<{ abc_class: string; n: string; v: string }[]>('annual_value as v')
        .groupBy('abc_class');

      const by_class: Record<string, { count: number; value: number }> = { A: { count: 0, value: 0 }, B: { count: 0, value: 0 }, C: { count: 0, value: 0 } };
      for (const r of summary) by_class[r.abc_class] = { count: Number(r.n), value: Number(r.v) };
      const classified = (inserted.rowCount ?? 0);
      this.logger.log(`ABC recomputado: ${classified} (almacén,producto) clasificados (ventana ${windowDays}d).`);
      return { classified, window_days: windowDays, by_class };
    });
  }

  /**
   * ABC.1 — qué toca contar (conteo cíclico): cruza la clasificación ABC con el
   * historial reconciliado para calcular `next_due = last_counted_at + cadencia(clase)`.
   * Nunca contado → due ya. Ordena por prioridad (A primero, más vencido primero).
   */
  async cycleDue(query: { warehouse_id?: string; abc_class?: string; only_due?: boolean } = {}) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (query.abc_class && !['A', 'B', 'C'].includes(String(query.abc_class).toUpperCase()))
      throw new BadRequestException('abc_class debe ser A, B o C');
    const onlyDue = query.only_due !== false; // default true

    return this.tk.run(async (trx) => {
      const filters: string[] = [];
      const binds: any[] = [];
      if (query.warehouse_id) { filters.push('a.warehouse_id = ?'); binds.push(query.warehouse_id); }
      if (query.abc_class) { filters.push('a.abc_class = ?'); binds.push(String(query.abc_class).toUpperCase()); }
      const whereInner = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const dueExpr = `(r.last_counted_at IS NULL OR r.last_counted_at + (r.cadence_days || ' days')::interval <= now())`;

      const rows = (await trx.raw(
        `
        WITH last_counted AS (
          SELECT c.warehouse_id, i.product_id, MAX(c.reconciled_at) AS last_counted_at
            FROM commercial.inventory_counts c
            JOIN commercial.inventory_count_items i ON i.count_id = c.id AND i.tenant_id = c.tenant_id
           WHERE c.status = 'reconciled' AND i.product_id IS NOT NULL
           GROUP BY c.warehouse_id, i.product_id
        ),
        ranked AS (
          SELECT a.warehouse_id, a.product_id, a.abc_class, a.annual_value, lc.last_counted_at,
                 (CASE a.abc_class WHEN 'A' THEN ${CADENCE_DAYS.A} WHEN 'B' THEN ${CADENCE_DAYS.B} ELSE ${CADENCE_DAYS.C} END) AS cadence_days
            FROM commercial.abc_classification a
            LEFT JOIN last_counted lc ON lc.warehouse_id = a.warehouse_id AND lc.product_id = a.product_id
            ${whereInner}
        )
        SELECT r.warehouse_id, w.code AS warehouse_code, r.product_id, p.sku, p.nombre AS product_name,
               r.abc_class, r.annual_value, r.last_counted_at, r.cadence_days,
               (r.last_counted_at + (r.cadence_days || ' days')::interval) AS next_due,
               ${dueExpr} AS is_due,
               CASE WHEN r.last_counted_at IS NULL THEN NULL
                    ELSE EXTRACT(DAY FROM now() - (r.last_counted_at + (r.cadence_days || ' days')::interval))::int END AS days_overdue
          FROM ranked r
          JOIN commercial.warehouses w ON w.id = r.warehouse_id
          LEFT JOIN public.products p ON p.id = r.product_id
          ${onlyDue ? `WHERE ${dueExpr}` : ''}
         ORDER BY CASE r.abc_class WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, r.last_counted_at ASC NULLS FIRST
         LIMIT 2000
        `,
        binds,
      )).rows;

      const by_class: Record<string, number> = { A: 0, B: 0, C: 0 };
      for (const r of rows) if (r.is_due) by_class[r.abc_class] = (by_class[r.abc_class] || 0) + 1;
      return { cadence_days: CADENCE_DAYS, only_due: onlyDue, count: rows.length, by_class, items: rows };
    });
  }

  /** Lee la clasificación vigente (con nombre de producto/almacén). */
  async listAbc(query: { warehouse_id?: string; abc_class?: string } = {}) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (query.abc_class && !['A', 'B', 'C'].includes(query.abc_class))
      throw new BadRequestException('abc_class debe ser A, B o C');
    return this.tk.run(async (trx) => {
      let q = trx('commercial.abc_classification as a')
        .join('commercial.warehouses as w', 'w.id', 'a.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 'a.product_id');
      if (query.warehouse_id) q = q.where('a.warehouse_id', query.warehouse_id);
      if (query.abc_class) q = q.where('a.abc_class', query.abc_class);
      return q
        .select(
          'a.warehouse_id',
          'w.code as warehouse_code',
          'a.product_id',
          'p.sku as sku',
          'p.nombre as product_name',
          'a.abc_class',
          'a.annual_value',
          'a.units_window',
          'a.value_share',
          'a.window_days',
          'a.computed_at',
        )
        .orderBy('a.warehouse_id', 'asc')
        .orderBy('a.annual_value', 'desc')
        .limit(2000);
    });
  }
}
