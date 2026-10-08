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
      // [IC.20] La foto recibe el DESGLOSE que la vista ya calculaba y se tiraba: el lugar
      // dentro del almacen, su denominador, el aporte individual (distinto de `value_share`,
      // que es el ACUMULADO) y la distancia al piso de su propia clase. Mas `tiene_testigo`,
      // que es el flag canonico de cobertura del costo.
      const inserted = await trx.raw(
        `
        INSERT INTO commercial.abc_classification
          (tenant_id, warehouse_id, product_id, abc_class, annual_value, units_window, value_share,
           window_days, computed_at, costo_source, clase_motivo,
           rango_almacen, skus_en_almacen, aporte_individual, distancia_al_corte, tiene_testigo)
        SELECT tenant_id, warehouse_id, product_id, abc_class, annual_value,
               (avg_daily_units * ?)::numeric, value_share, ?::int, now(), costo_source, clase_motivo,
               rango_almacen, skus_en_almacen, aporte_individual, distancia_al_corte, tiene_testigo
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
        // [IC.20] Antes esto era una lista de NOMBRES a mano. Medido el 2026-10-07 sobre las
        // 30,059 filas, esa lista y la columna `tiene_testigo` coinciden exacto: 0 discrepancias,
        // o sea que NO habia un error vivo. Se cambia por la fragilidad, no por el bug: un
        // `costo_source` nuevo CON testigo quedaria fuera de la lista y la cobertura se
        // subdeclararia en silencio. El flag lo decide el resolvedor del costo, no este archivo.
        trx.raw(`COUNT(*) FILTER (WHERE tiene_testigo)::int AS con_testigo`),
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
   *
   * ── `[ABC.6]` DOS DEFECTOS MEDIDOS EN PROD (2026-09-30), los dos del mismo `LIMIT 2000` ──
   *
   * 1. ⛔ **`by_class` se contaba sobre la PÁGINA, no sobre el universo.** Con todo el catálogo
   *    sin contar nunca, las 4,987 A se comían el límite enteras y la pantalla publicaba
   *    **«2,000 pendientes · A 2000 · B 0 · C 0»** cuando lo vencido era **39,480 (A 4,987 ·
   *    B 6,822 · C 27,671)**. O sea: subdeclaraba el trabajo en 95% y afirmaba DOS CEROS
   *    FALSOS. Un cero de más no es un número chico: es una clase entera que desaparece del
   *    plan sin que nadie lo decida.
   *
   * 2. ⛔ **Y B y C no eran invisibles por diseño, sino por truncamiento** — que es peor,
   *    porque el diseño se discute y el truncamiento no se ve. Ahora el conteo por clase sale
   *    de un `COUNT` sobre TODO, la página se declara `truncado`, y el orden dentro de cada
   *    clase pasa a ser el **valor anual descendente**: con `last_counted_at` NULL en todas las
   *    filas, ordenar por esa columna era un desempate arbitrario disfrazado de prioridad.
   *
   * ── El PORQUÉ de la clase viaja con la fila ─────────────────────────────────────────────
   *
   * `motivo_clase` es la columna **canónica** `clase_motivo` (KE.4b), que la tabla ya traía
   * poblada desde `analytics.v_abc_class`. ⛔ La primera versión de este cambio la **re-derivaba**
   * acá — una segunda definición del mismo concepto, que es exactamente el defecto que KE.4
   * cerró cuando la pantalla mostraba otra clase que el motor (coincidían en 64%).
   *
   * ⚠️ **HALLAZGO DECLARADO, NO CORREGIDO** (medido en prod 2026-09-30): `clase_motivo` marca
   * `sin_demanda` cuando el **ALMACÉN entero** no vende — `adu_almacen <= 0` en la vista, que
   * hoy son las **10,125 filas del CEDIS**, que distribuye por traspaso. Pero hay **5,865 filas
   * más** con `avg_daily_units = 0` y `annual_value = $0` **en almacenes que sí venden**, y esas
   * caen en el `ELSE` y se rotulan `pareto`: o sea *"es C por su lugar en el Pareto"* sobre una
   * fila que no tiene valor que ordenar.
   *
   * ⛔ **No se arregla acá y hay una razón concreta:** `import-network-reorder.js:99` decide el
   * nivel de servicio del CEDIS con `clase_motivo = 'sin_demanda' THEN 'A'`. Cambiar la
   * semántica de esa etiqueta mueve una decisión de COMPRA, y eso es de la fase KE, no de una
   * revisión de pantalla. Lo que sí se hace es **exponer el hecho** (`sin_demanda_en_fila`) al
   * lado del motivo, para que la pantalla no afirme un Pareto sobre un valor ausente.
   */
  async cycleDue(query: {
    warehouse_id?: string; abc_class?: string; only_due?: boolean; limit?: number;
  } = {}) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (query.abc_class && !['A', 'B', 'C'].includes(String(query.abc_class).toUpperCase()))
      throw new BadRequestException('abc_class debe ser A, B o C');
    const onlyDue = query.only_due !== false; // default true
    const limit = Math.min(5000, Math.max(50, Number(query.limit) || 2000));

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
          SELECT a.warehouse_id, a.product_id, a.abc_class, a.annual_value, a.units_window,
                 a.value_share, a.window_days, a.computed_at, lc.last_counted_at,
                 (CASE a.abc_class WHEN 'A' THEN ${CADENCE_DAYS.A} WHEN 'B' THEN ${CADENCE_DAYS.B} ELSE ${CADENCE_DAYS.C} END) AS cadence_days,
                 -- EL PORQUE, con la fila. Sale de la columna CANONICA que la tabla ya trae
                 -- (KE.4b, poblada desde analytics.v_abc_class): pareto / sin_demanda / sin_costo.
                 -- Derivarlo aca seria una SEGUNDA definicion, que es justo el defecto que KE.4
                 -- cerro cuando la pantalla mostraba otra clase que el motor (64% de acuerdo).
                 a.clase_motivo AS motivo_clase,
                 -- ⚠️ HALLAZGO DECLARADO, no corregido (ver el bloque de arriba): hay filas con
                 -- demanda CERO que el resolvedor rotula 'pareto'. Esto NO las re-etiqueta --
                 -- expone el hecho medible al lado del motivo, para que la pantalla no diga
                 -- "es C por su lugar en el Pareto" sobre una fila sin valor que ordenar.
                 (coalesce(a.units_window, 0) = 0) AS sin_demanda_en_fila
            FROM commercial.abc_classification a
            LEFT JOIN last_counted lc ON lc.warehouse_id = a.warehouse_id AND lc.product_id = a.product_id
            ${whereInner}
        ),
        -- ⛔ EL CONTEO REAL, sobre TODO el universo y no sobre la página. Contarlo después del
        -- LIMIT es lo que publicaba «B 0 · C 0» con 6,822 y 27,671 vencidas esperando.
        totales AS (
          SELECT abc_class, count(*)::int AS vencidas
            FROM ranked r ${onlyDue ? `WHERE ${dueExpr}` : ''}
           GROUP BY 1
        ),
        pagina AS (
          SELECT r.warehouse_id, w.code AS warehouse_code, r.product_id, p.sku, p.nombre AS product_name,
                 r.abc_class, r.annual_value, r.units_window, r.value_share, r.window_days,
                 r.computed_at, r.motivo_clase, r.last_counted_at, r.cadence_days,
                 (r.last_counted_at + (r.cadence_days || ' days')::interval) AS next_due,
                 ${dueExpr} AS is_due,
                 CASE WHEN r.last_counted_at IS NULL THEN NULL
                      ELSE EXTRACT(DAY FROM now() - (r.last_counted_at + (r.cadence_days || ' days')::interval))::int END AS days_overdue
            FROM ranked r
            JOIN commercial.warehouses w ON w.id = r.warehouse_id
            LEFT JOIN public.products p ON p.id = r.product_id
            ${onlyDue ? `WHERE ${dueExpr}` : ''}
           -- Dentro de la clase manda el VALOR, no last_counted_at: con todo sin contar esa
           -- columna es NULL en el 100% de las filas y el "más vencido primero" era un
           -- desempate arbitrario disfrazado de prioridad. El desempate final por product_id
           -- es lo que vuelve el orden estable entre dos corridas.
           ORDER BY CASE r.abc_class WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END,
                    r.last_counted_at ASC NULLS FIRST, r.annual_value DESC, r.product_id
           LIMIT ${limit}
        )
        SELECT (SELECT json_agg(x) FROM (SELECT * FROM pagina) x)   AS items,
               (SELECT json_agg(t) FROM (SELECT * FROM totales) t)  AS totales
        `,
        binds,
      )).rows;

      const items = rows[0]?.items || [];
      const by_class: Record<string, number> = { A: 0, B: 0, C: 0 };
      for (const t of (rows[0]?.totales || [])) by_class[t.abc_class] = Number(t.vencidas);
      const total = by_class.A + by_class.B + by_class.C;
      return {
        cadence_days: CADENCE_DAYS,
        only_due: onlyDue,
        /** ⛔ El total REAL de vencidas, no el de la página. Era el defecto. */
        count: total,
        by_class,
        /** Cuántas filas viajan en esta respuesta. */
        mostradas: items.length,
        limit,
        /** Se DECLARA: una página recortada y un universo chico se leen igual sin esto. */
        truncado: total > items.length,
        items,
      };
    });
  }

  /**
   * Lee la clasificación vigente (con nombre de producto/almacén).
   *
   * `[ABC.6]` Devolvía un array pelado con `LIMIT 2000` **mudo**: 39,480 filas clasificadas y
   * la pantalla mostraba 2,000 sin decir que había recortado. Ahora devuelve el total real y
   * `truncado`, y cada fila trae **por qué** tiene esa clase.
   */
  async listAbc(query: { warehouse_id?: string; abc_class?: string; limit?: number } = {}) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (query.abc_class && !['A', 'B', 'C'].includes(query.abc_class))
      throw new BadRequestException('abc_class debe ser A, B o C');
    const limit = Math.min(5000, Math.max(50, Number(query.limit) || 2000));
    return this.tk.run(async (trx) => {
      const base = () => {
        let q = trx('commercial.abc_classification as a');
        if (query.warehouse_id) q = q.where('a.warehouse_id', query.warehouse_id);
        if (query.abc_class) q = q.where('a.abc_class', query.abc_class);
        return q;
      };
      const [items, [{ total }]] = await Promise.all([
        base()
          .join('commercial.warehouses as w', 'w.id', 'a.warehouse_id')
          .leftJoin('public.products as p', 'p.id', 'a.product_id')
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
            // El mismo criterio que la agenda, escrito UNA vez acá abajo tampoco: si algún día
            // son tres consumidores, sube a una vista. Con dos, duplicarlo se ve.
            // La columna CANONICA (KE.4b), no una segunda derivacion.
            'a.clase_motivo as motivo_clase',
            trx.raw('(coalesce(a.units_window, 0) = 0) AS sin_demanda_en_fila'),
          )
          .orderBy('a.warehouse_id', 'asc')
          .orderBy('a.annual_value', 'desc')
          .orderBy('a.product_id', 'asc')     // desempate estable entre corridas
          .limit(limit),
        base().count<{ total: string }[]>('* as total'),
      ]);
      return {
        items,
        total: Number(total),
        mostradas: items.length,
        limit,
        truncado: Number(total) > items.length,
        /** El criterio, con la data: lo que la pantalla necesita para explicar la letra. */
        criterio: {
          metrica: 'valor de consumo anualizado = demanda diaria × 365 × costo unitario',
          demanda: 'analytics.inventory_health.avg_daily_units (misma que usa el punto de reorden)',
          costo: 'analytics.v_erp_unit_cost (kdik.c16 por pieza en Kepler · costo_promedio en Wincaja)',
          corte: 'Pareto POR ALMACÉN — A hasta 80% del valor acumulado · B 80–95% · C el resto',
          ventana_dias: DEFAULT_WINDOW_DAYS,
          cadencia_dias: CADENCE_DAYS,
        },
      };
    });
  }

  /**
   * `[IC.24]` — **La selección del conteo, con el porqué de cada producto.**
   *
   * Hasta acá la pantalla podía decir *qué* contar. No podía decir *por qué ése y no otro*, ni
   * *qué tan confiable es el número que lo puso ahí*. Las piezas ya existían repartidas en cinco
   * objetos; esto las junta en una fila.
   *
   * ── El motor de la selección, por ritmo ────────────────────────────────────────────────
   *
   * ⭐ **`diario` se siembra con el HECHO DE VENTA** (`analytics.sales_daily.cost`, COGS real de
   * 30 días), no con `v_count_priority_score`. Medido el 2026-10-07: el score cubre el **5.5%**
   * del COGS con **4× el esfuerzo** (94,739 piezas contra 23,758) y su mediana de cobertura es
   * **93 días** — contar mañana esa pila es contar la misma pila. La causa: el score suma
   * `s_venta` y `s_parado`, que se oponen (sus top-25 comparten **0 a 5 de 25**).
   *
   * El hecho de venta además es **pesos**, o sea inmune a la unidad: el mismo SKU `57009`
   * (COBERTURA 20K LUSSEL) que el catálogo publica en $42,536/día cuesta $4,594 reales, 9.3×,
   * porque la existencia va en cubetas y la venta en kilos.
   *
   * ── El filtro de velocidad, y por qué ──────────────────────────────────────────────────
   *
   * `dias_cobertura` acota a lo que **cambia** dentro del horizonte del ritmo. Un SKU con 93 días
   * de cobertura no se mueve de un día para otro. ⚠️ Es una cobertura **declarada, no verificada**:
   * `on_hand` y `avg_daily_units` pueden venir en peldaños distintos (ADR-057), y donde eso pasa
   * el número miente. Se publica `cobertura_confiable` para que la pantalla lo diga.
   *
   * ── Rendimiento: el LIMIT va DENTRO del CTE ────────────────────────────────────────────
   *
   * ⚠️ Medido: con los `LEFT JOIN` a las vistas por fuera del recorte, **6,865 ms**; metiendo el
   * `LIMIT` en `elegidos`, **135 ms**. Los joins caros corren sobre N filas y no sobre las 4,511
   * del almacén.
   *
   * ⛔ Y lo que **NO** entra acá, con su medición: `v_sku_count_variance_history` (589 ms) y
   * `v_abc_capital` (346 ms) calculan su partición completa aunque se filtre por producto
   * (589 → 539 ms al acotar a 25 SKUs: casi nada). Van en el DETALLE, que es una fila.
   */
  async countSelection(query: {
    warehouse_id: string;
    ritmo?: 'diario' | 'mensual';
    dias_cobertura?: number | null;
    limit?: number;
  }) {
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));
    const ritmo = query.ritmo === 'mensual' ? 'mensual' : 'diario';
    // El mensual mira el COMPLEMENTO (lo que el diario no toca) y no tiene tope de velocidad:
    // su trabajo es justo el inventario que NO rota. `null` = sin filtro.
    const diasCobertura = query.dias_cobertura === null
      ? null
      : (Number(query.dias_cobertura) || (ritmo === 'diario' ? 30 : null));

    return this.tk.run(async (trx) => {
      const rows = (await trx.raw(
        `
        WITH wh AS (SELECT id, code FROM commercial.warehouses WHERE id = ?::uuid),
        flujo AS (
          SELECT d.product_id,
                 SUM(d.cost) / 30.0  AS cogs_dia,
                 SUM(d.units) / 30.0 AS udia
            FROM analytics.sales_daily d
            JOIN wh ON wh.id = d.warehouse_id
           WHERE d.sale_date >= CURRENT_DATE - 30
           GROUP BY 1
          HAVING SUM(d.cost) > 0
        ),
        -- ⭐ EL RECORTE VA ACA. Fuera de este CTE, el plan calcula las vistas para el almacen
        --    entero y recorta despues: 6,865 ms contra 135 ms.
        elegidos AS (
          SELECT a.warehouse_id, a.product_id, f.cogs_dia, f.udia,
                 ih.on_hand, ih.days_cover,
                 a.abc_class, a.clase_motivo, a.rango_almacen, a.skus_en_almacen,
                 a.aporte_individual, a.annual_value, a.distancia_al_corte, a.tiene_testigo
            FROM commercial.abc_classification a
            JOIN wh ON wh.id = a.warehouse_id
            JOIN flujo f ON f.product_id = a.product_id
            LEFT JOIN analytics.inventory_health ih
                   ON ih.warehouse_id = a.warehouse_id AND ih.product_id = a.product_id
           WHERE (?::int IS NULL OR COALESCE(ih.days_cover, 1e9) <= ?::int)
           ORDER BY f.cogs_dia DESC
           LIMIT ?
        )
        SELECT e.product_id, p.sku, p.nombre, p.location,
               e.abc_class, e.clase_motivo,
               e.rango_almacen::int, e.skus_en_almacen::int,
               e.aporte_individual::float8, e.annual_value::float8,
               e.distancia_al_corte::float8, e.tiene_testigo,
               e.cogs_dia::float8, e.udia::float8,
               e.on_hand::float8, e.days_cover::float8,
               clk.estado AS reloj_estado, clk.fuente AS reloj_fuente,
               clk.last_counted_at, clk.next_due
          FROM elegidos e
          JOIN catalog.products p ON p.id = e.product_id
          LEFT JOIN analytics.v_count_clock clk
                 ON clk.warehouse_id = e.warehouse_id AND clk.product_id = e.product_id
                AND clk.ritmo = 'trimestral'
         ORDER BY e.cogs_dia DESC`,
        [query.warehouse_id, diasCobertura, diasCobertura, limit],
      )).rows as Record<string, unknown>[];

      const num = (v: unknown) => (v == null ? 0 : Number(v));
      const items: Record<string, unknown>[] = rows.map((r) => ({
        ...r,
        /** ⚠️ La cobertura cruza dos columnas que pueden venir en peldanos distintos (ADR-057). */
        cobertura_confiable: r.days_cover != null && r.on_hand != null,
      }));

      const piezas = items.reduce((s, r) => s + num(r.on_hand), 0);
      const cogs = items.reduce((s, r) => s + num(r.cogs_dia), 0);
      const [tot] = await trx.raw(
        `SELECT COALESCE(SUM(d.cost), 0)::float8 / 30.0 AS cogs_dia_almacen
           FROM analytics.sales_daily d
          WHERE d.warehouse_id = ?::uuid AND d.sale_date >= CURRENT_DATE - 30`,
        [query.warehouse_id],
      ).then((r: { rows: { cogs_dia_almacen: number }[] }) => r.rows);

      return {
        items,
        ritmo,
        limit,
        /** El ESFUERZO, que es lo que de verdad acota un conteo: piezas, no renglones. */
        esfuerzo: {
          skus: items.length,
          piezas: Math.round(piezas),
          /**
           * ⛔ NO se publica un tiempo estimado: **piezas por hora por persona no existe** —
           * nunca se cerró un folio. Inventar una tasa sería dibujar una medición (ADR-056).
           */
          minutos_estimados: null,
          minutos_motivo: 'piezas_por_hora_sin_medir',
        },
        /** La COBERTURA: cuánto del dinero que se mueve al día queda dentro de la selección. */
        cobertura: {
          cogs_dia_seleccion: Math.round(cogs),
          cogs_dia_almacen: Math.round(Number(tot?.cogs_dia_almacen) || 0),
          pct: tot?.cogs_dia_almacen ? +((100 * cogs) / Number(tot.cogs_dia_almacen)).toFixed(1) : null,
        },
        /** El CRITERIO, con la data: lo que la pantalla necesita para explicar la selección. */
        criterio: {
          motor: 'analytics.sales_daily.cost — COGS real de 30 días, por almacén',
          por_que_no_el_score:
            'v_count_priority_score suma s_venta y s_parado, que se oponen: cubre 5.5% del COGS '
            + 'con 4× el esfuerzo y su mediana de cobertura es 93 días',
          orden: 'pesos de COGS por día, descendente',
          filtro_velocidad: diasCobertura == null ? null : `días de cobertura ≤ ${diasCobertura}`,
          cupo: 'se corta por PIEZAS, no por número de SKUs — el renglón no es la unidad de trabajo',
        },
      };
    });
  }

  /**
   * `[IC.24]` El **porqué profundo** de un SKU: su historia de conteos y su capital.
   *
   * Vive aparte de la lista por una razón medida, no por estética: `v_sku_count_variance_history`
   * cuesta **589 ms** y `v_abc_capital` **346 ms**, y ninguna baja al filtrar por producto porque
   * calculan su partición entera. En la lista serían 1,083 ms; acá, sobre una fila, son ~450 ms.
   *
   * ⭐ La historia sale de `analytics.mv_erp_count_line_signals` (**12 ms**, materializada) y no
   * de la vista: trae las mismas señales **más** `explicacion`, que es la que dice en castellano
   * por qué ese descuadre pudo no ser una merma — por ejemplo `costo_de_caja`, el hallazgo de
   * `[IC.12]` donde un «sobrante» de $788,730 era el peldaño del costo, no producto faltante.
   */
  async countSelectionDetail(query: { warehouse_id: string; product_id: string }) {
    return this.tk.run(async (trx) => {
      const [eventos, capital] = await Promise.all([
        trx.raw(
          `SELECT s.fecha::date AS fecha, s.veces_contado::int, s.veces_descuadro::int,
                  s.pesos_abs_hist::float8  AS pesos_abs,
                  s.pesos_neto_hist::float8 AS pesos_neto,
                  s.retencion::float8, s.patron,
                  s.importe_neto::float8 AS importe_evento,
                  s.cantidad_neta::float8 AS cantidad_evento,
                  s.unidad_erp, s.rf_veredicto, s.flujo_dominante, s.explicacion
             FROM analytics.mv_erp_count_line_signals s
            WHERE s.warehouse_id = ?::uuid AND s.product_id = ?::uuid
            ORDER BY s.fecha DESC
            LIMIT 10`,
          [query.warehouse_id, query.product_id],
        ).then((r: { rows: unknown[] }) => r.rows),
        trx.raw(
          `SELECT capital::float8, capital_class, costo_unitario::float8,
                  rango_almacen::int, skus_en_almacen::int,
                  aporte_individual::float8, costo_source, tiene_testigo, costo_veredicto
             FROM analytics.v_abc_capital
            WHERE warehouse_id = ?::uuid AND product_id = ?::uuid`,
          [query.warehouse_id, query.product_id],
        ).then((r: { rows: unknown[] }) => r.rows[0] ?? null),
      ]);

      return {
        eventos,
        capital,
        /** ADR-056: las dos ausencias no son la misma, y la pantalla las muestra distinto. */
        sin_historia: eventos.length === 0,
        sin_capital_motivo: capital ? null : 'sin_existencia_o_sin_costo',
        fuentes: {
          historia: 'analytics.mv_erp_count_line_signals (físico de Kepler, materializado)',
          capital: 'analytics.v_abc_capital (existencia × costo del ERP, mismo peldaño)',
        },
      };
    });
  }
}
