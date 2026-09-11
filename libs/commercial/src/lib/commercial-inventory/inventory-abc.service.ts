import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * Fase ABC.0 — clasificación ABC por (almacén, producto). Ver FASE_ABC_CYCLE_COUNT.md.
 *
 * Métrica = **valor de consumo anualizado** = demanda diaria × 365 × costo unitario.
 * Pareto POR ALMACÉN: A = hasta 80% del valor acumulado · B = 80–95% · C = resto.
 *
 * ── KE.4 (2026-09-10) — ESTA CLASIFICACIÓN ERA UN OBJETO NULO ───────────────────────────────
 *
 * Edgar: *"no se puede comprar con una información errónea, si no la compra se hace mal y afecta
 * todo"*. Y acá estaba el peor caso, porque **esta clase fija el nivel de servicio de TODO el
 * reabasto** (import-computed-reorder.js: A=0.98 · B=0.95 · C/sin clase=0.90).
 *
 * La demanda salía de `commercial.orders` — la tabla de pedidos de la PLATAFORMA, que tiene
 * **2 órdenes fulfilled en toda su historia** — mientras la venta real son 707,022 celdas /
 * $154.7M en 90 días. Resultado medido en prod: **2 filas clase A y 56,002 clase C con
 * `annual_value` = $0**, y **clase B = 0 en todo el sistema** (un Pareto siempre produce B: ése
 * era el delator a la vista de cualquiera).
 *
 * Costo: **19,127 políticas de sucursal servidas a 0.90**, de las cuales el ABC real dice que
 * 4,467 son A y 5,782 son B → **10,245 políticas mal servidas y $1,256,078 de inventario de
 * protección que no se está comprando**.
 *
 * ── Lo que se corrige, y por qué ESA fuente ─────────────────────────────────────────────────
 *
 * La demanda pasa a salir de **`analytics.inventory_health.avg_daily_units`**, que es
 * **exactamente la demanda que usa el punto de reorden** (import-computed-reorder.js:76). No es
 * "una fuente mejor": es **la misma**. Si la clase y la sigma/ADU vinieran de ventanas distintas,
 * la política sería incoherente consigo misma.
 *
 * Y está en **PIEZAS** (unidad canónica del motor, decidida 2026-07-27 y verificada contra
 * movimientos de compra reales), igual que `analytics.v_erp_unit_cost` — que es `kdik.c16` por
 * pieza en Kepler y `costo_promedio` en la unidad nativa de Wincaja. Las dos puntas del producto
 * están en la misma unidad y en el mismo ERP: eso es lo que hace válida la multiplicación
 * (ADR-055: la unidad no se hereda de su fuente, se prueba).
 *
 * Medido con la fuente nueva (prod, 2026-09-10): **A 5,178 filas / $371,867,053 · B 7,367 /
 * $69,675,257 · C 42,756 / $23,216,311**, con Pareto sano por sucursal (A 15–19%, B 21–27%).
 *
 * ⚠️ Dos almacenes dan 0 A / 0 B, y los dos tienen explicación NOMBRADA:
 *   · **`00` (CEDIS)** no vende: distribuye por traspaso. Su reorden lo planea
 *     import-network-reorder.js con demanda dependiente y servicio 0.98 fijo.
 *   · **`07`** está rezagada en `inventory_health` (0 demanda en sus 2,617 filas) aunque la venta
 *     ya existe: la cadena norm→vel produce hoy 1,337 SKUs con demanda. Se corrige sola en la
 *     próxima corrida del importer. ⚠️ Y aun así arranca con **3 días de historia sobre un
 *     divisor de 90**, así que su ADU va a estar subdeclarada ~30× hasta que la ventana se llene.
 *
 * ⭐ **EL FRENO QUE FALTABA.** El recompute es DELETE + INSERT atómico. Eso está bien **salvo que
 * la fuente se vacíe**: ahí borra lo bueno y publica "todo es C", que es exactamente cómo se
 * fabricó el objeto nulo de arriba y por qué nadie lo vio en dos meses. Ahora se mide la fuente
 * ANTES de borrar y se aborta si no trae demanda (ADR-056: un vacío se DECLARA, no se publica).
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

    // La ventana NO es libre: la demanda sale de `analytics.inventory_health`, que se computa
    // sobre 90 dias fijos. Aceptar otra y clasificar igual seria publicar una etiqueta falsa.
    if (windowDays !== DEFAULT_WINDOW_DAYS) {
      throw new BadRequestException(
        `window_days=${windowDays} no es aplicable: la demanda sale de analytics.inventory_health, `
        + `que se computa sobre una ventana fija de ${DEFAULT_WINDOW_DAYS} dias. `
        + `Para cambiarla hay que cambiarla en import-inventory-health.js, no aca.`,
      );
    }

    return this.tk.run(async (trx) => {
      // EL FRENO: medir la fuente ANTES de borrar. Un DELETE+INSERT desde una fuente vacia no
      // falla -- publica "todo es C", que es indistinguible de un catalogo de bajo valor. Asi
      // estuvo esta tabla desde que se escribio, y por eso nadie lo vio en dos meses.
      const [src] = await trx('analytics.inventory_health').select(
        trx.raw('COUNT(*)::int AS filas'),
        trx.raw('COUNT(*) FILTER (WHERE avg_daily_units > 0)::int AS con_demanda'),
      );
      if (!src || Number(src.con_demanda) < 1) {
        throw new Error(
          `ABC abortado: analytics.inventory_health trae ${src?.filas ?? 0} filas y `
          + `${src?.con_demanda ?? 0} con demanda. Recalcular sobre una fuente vacia publicaria `
          + `"todo clase C" y bajaria el nivel de servicio de toda la red a 0.90.`,
        );
      }

      await trx.raw('DELETE FROM commercial.abc_classification'); // RLS-scoped al tenant

      // [KE.4] La definicion del Pareto vive en `analytics.v_abc_class`, NO aca. La tabla es la
      // FOTO (la consumen la cadencia de conteo ciclico y los importers de reorden que necesitan
      // un snapshot); la vista es la definicion. Duplicar el CASE del Pareto en los dos lados es
      // exactamente el primitivo con dos implementaciones que ADR-056 prohibe.
      const inserted = await trx.raw(
        `
        INSERT INTO commercial.abc_classification
          (tenant_id, warehouse_id, product_id, abc_class, annual_value, units_window, value_share,
           window_days, computed_at, costo_source, clase_motivo)
        SELECT tenant_id, warehouse_id, product_id, abc_class, annual_value,
               (avg_daily_units * ?)::numeric, value_share, ?::int, now(), costo_source, clase_motivo
          FROM analytics.v_abc_class`,
        [windowDays, windowDays],
      );

      const summary = await trx('commercial.abc_classification')
        .select('abc_class')
        .count<{ abc_class: string; n: string }[]>('* as n')
        .sum<{ abc_class: string; n: string; v: string }[]>('annual_value as v')
        .groupBy('abc_class');

      const by_class: Record<string, { count: number; value: number }> = { A: { count: 0, value: 0 }, B: { count: 0, value: 0 }, C: { count: 0, value: 0 } };
      for (const r of summary) by_class[r.abc_class] = { count: Number(r.n), value: Number(r.v) };
      const classified = (inserted.rowCount ?? 0);
      // EL DELATOR, convertido en compuerta. Un Pareto SIEMPRE produce clase B; que B fuera 0 en
      // todo el sistema era la senal de que la fuente estaba vacia, y estuvo a la vista dos meses
      // sin que nada la mirara. La trx se revierte: mejor la foto de ayer que "todo es C".
      if ((by_class.B?.count ?? 0) < 1 || (by_class.A?.count ?? 0) < 1) {
        throw new Error(
          `ABC degenerado: A=${by_class.A?.count ?? 0} B=${by_class.B?.count ?? 0} sobre `
          + `${classified} filas. Un Pareto siempre produce B — se aborta antes de bajar el nivel `
          + `de servicio de toda la red a 0.90.`,
        );
      }
      // [KE.3] La cobertura del costo viaja con el resultado: una clasificacion hecha sobre
      // costos ausentes manda a C por ausencia, no por bajo valor (ADR-056).
      const [cov] = await trx('commercial.abc_classification').select(
        trx.raw(`COUNT(*)::int AS total`),
        trx.raw(`COUNT(*) FILTER (WHERE costo_source IN ('kepler_kdik','wincaja_costo_promedio'))::int AS con_testigo`),
        trx.raw(`COUNT(*) FILTER (WHERE costo_source = 'sin_costo')::int AS sin_costo`),
        trx.raw(`COUNT(*) FILTER (WHERE clase_motivo = 'sin_demanda')::int AS sin_demanda`),
      );
      this.logger.log(`ABC recomputado: ${classified} (almacén,producto) clasificados (ventana ${windowDays}d).`);
      return {
        classified,
        window_days: windowDays,
        by_class,
        costo: {
          resolver: 'analytics.v_abc_class sobre analytics.v_erp_unit_cost',
          con_testigo_erp: Number(cov?.con_testigo) || 0,
          sin_costo: Number(cov?.sin_costo) || 0,
          /** [KE.4b] Cuántas C son C por no haber demanda en ese almacén, no por bajo valor. */
          sin_demanda: Number(cov?.sin_demanda) || 0,
          cobertura_pct: Number(cov?.total) > 0
            ? +(((Number(cov.con_testigo) || 0) / Number(cov.total)) * 100).toFixed(2) : null,
        },
      };
    });
  }

  /** Resumen agregado (KPIs): conteo + valor por clase, total, última corrida. Barato (GROUP BY). */
  async summary(query: { warehouse_id?: string } = {}) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      let q = trx('commercial.abc_classification');
      if (query.warehouse_id) q = q.where({ warehouse_id: query.warehouse_id });
      const rows = await q
        .select('abc_class')
        .count<{ abc_class: string; n: string; v: string; last: string }[]>('* as n')
        .sum('annual_value as v')
        .max('computed_at as last')
        .groupBy('abc_class');
      const by_class: Record<string, { count: number; value: number }> = {
        A: { count: 0, value: 0 }, B: { count: 0, value: 0 }, C: { count: 0, value: 0 },
      };
      let total_count = 0, total_value = 0;
      let computed_at: string | null = null;
      for (const r of rows) {
        by_class[r.abc_class] = { count: Number(r.n), value: Number(r.v) };
        total_count += Number(r.n);
        total_value += Number(r.v);
        if (r.last && (!computed_at || r.last > computed_at)) computed_at = r.last;
      }
      return { by_class, total_count, total_value, computed_at };
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
