import { Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import {
  TenantKnexService, TenantContextService, evalInput, composeFreshness, laneAt, FRESHNESS_UNKNOWN,
} from '@megadulces/platform-core';
import type {
  BudgetResult, BudgetResultAnnual, BudgetResultArbitro, BudgetResultCell, BudgetResultHueco,
  BudgetResultMonth, BudgetResultSource,
} from '@megadulces/contracts';

/**
 * `[PU.R]` **El estado de resultados del presupuesto** (ADR-066 · ADR-056 · ADR-059).
 *
 * Es el paso 4+5+6+7 del mapa de ingresos y egresos
 * (`docs/IMPLEMENTACION/FASES/FASE_PU_MAPA_INGRESOS_EGRESOS.md`), y reemplaza al `resultado()`
 * anterior.
 *
 * ── QUÉ PUBLICABA LO ANTERIOR, MEDIDO CONTRA PROD ───────────────────────────────────────────
 * `ingresos (plan de ventas) − egresos (plan de gastos)`. Sobre el ejercicio FY2027 real:
 *
 *     Resultado  $468,804,497.42      Margen  100.00 %
 *
 * ⛔ No era un error aritmético: la fórmula **no tenía costo de ventas** —el 88 % del egreso de
 * esta empresa— y el plan de gastos está vacío, así que el sustraendo valía 0. Los meses sin plan
 * se dibujaban en `$0.00`, que es la falla que ADR-056 nombra: *un cero de ausencia se lee igual
 * que un cero de negocio*.
 *
 * ── LOS CUATRO RENGLONES, Y DE DÓNDE SALE CADA UNO ──────────────────────────────────────────
 *
 *     Venta              plan: budget.sales_plan_lines (13x4 -> mes por días)
 *                        real: analytics.mv_sales_blended      (el fact arbitrado, ADR-059)
 *   − Costo de ventas    plan: NO EXISTE -> se DECLARA (es el hueco que vale el 88 %)
 *                        real: analytics.mv_sales_blended.cost
 *   = Margen bruto
 *   − Gasto operativo    plan: budget.expense_plan_lines familia 6
 *                        real: analytics.expense_entries familia 6
 *   − Financieros        plan: budget.expense_plan_lines familia 7
 *                        real: analytics.expense_entries familia 7
 *   = Resultado
 *
 * Y **al lado, nunca sumado**: compra de inventario (cuenta 511) e inversión (cuenta 150). Son
 * salida de caja, no resultado. Medido ene-sep 2026: la compra son $453.7 M contra $55.9 M de
 * gasto operativo — meterlos en el mismo renglón multiplica el gasto por nueve.
 *
 * ── EL ÁRBITRO (ADR-059), Y UNO QUE SE DECLARA NO COMPARABLE ────────────────────────────────
 * · **Gasto operativo** contra `analytics.ledger_monthly` familia 6. Medido ene-sep 2026: **de
 *   abril en adelante cuadra al centavo** (0.00, −0.19, −502.11, −3,883.08, −9,586.22) y ene-mar
 *   difiere (+$175k, +$18k, −$1.0M). O sea que SÍ muerde, que es lo que lo vuelve un árbitro y no
 *   un espejo.
 *
 *   ⚠️ **PERO NO ES INDEPENDIENTE, y la primera versión de este comentario lo vendía como si lo
 *   fuera** («otra implementación del mismo hecho»). Verificado: `analytics.expense_entries`
 *   (`import-expenses-polizas.js`) y `analytics.ledger_monthly` (`import-ledger-chain.js`) leen
 *   **la misma tabla primaria**, `kepler_ods.kdc2YYMM`. Son dos implementaciones de **una sola
 *   fuente**: atrapan un error de filtro o de agregación —por eso ene-mar salta— y **no pueden
 *   atrapar un error de la fuente**. *Otra implementación no es otro testigo.*
 *
 *   ✅ `[VE.1]` **El árbitro independiente YA ESTÁ CABLEADO** — `analytics.v_expense_arbiter`,
 *   sobre `analytics.contpaqi_ledger_monthly` (los libros del contador, Fase CP / ADR-040). Esta
 *   pantalla publica los dos: el interno dice si la derivación es consistente, el independiente
 *   si el hecho lo es.
 *
 *   ⚠️ **Dos correcciones a lo que decía esta cabecera**, las dos medidas el 2026-10-06:
 *   (a) el filtro era `agrupador_sat IN ('601','602')` y **devuelve NULL**: el dato real trae
 *       subnivel (`601.01`, `602.56`), así que son `LIKE '601%'`/`'602%'`. La cifra de
 *       $44,040,196.72 estaba bien; el filtro con el que se la describía, no.
 *   (b) «el hueco es el alcance de la entidad fiscal» sigue **sin verificar**, y ahora además
 *       está medido en contra: la brecha no es un factor constante —va de −7.2 % a −44.1 % según
 *       el bloque— y en 3 de los 4 bloques hay al menos un mes donde el signo se invierte. Lo que
 *       falta es la correspondencia concepto→agrupador, y **la firma Contabilidad**.
 * · **Venta** contra `ledger_monthly` familia 4: **`no_comparable`, a propósito**. La balanza
 *   familia 4 trae el traspaso interno del CEDIS a sus propias tiendas —el 84.49 % de la póliza
 *   de ingreso en agosto-2026— y el fact de venta no. Restarlas daría una brecha que no es un
 *   error de nadie. Se publica la cifra del árbitro con su nota, no su delta.
 */

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** `[SD.3]` Mismo linaje que rentabilidad, sell-out y weekly. */
const SALES_FACT = 'analytics.mv_sales_blended';
const SALES_FACT_LANE = 'analytics_refresh_blended';
const SALES_FACT_LANE_WARN_H = 26;

/** Suma que distingue «todo nulo» de «cero»: si ningún sumando existe, el total es `null`. */
const add = (...xs: Array<number | null>): number | null => {
  const hay = xs.filter((x): x is number => x !== null);
  return hay.length ? round2(hay.reduce((s, x) => s + x, 0)) : null;
};
/**
 * ⛔ Resta ESTRICTA: si **cualquiera** de los dos lados es NO MEDIDO, el resultado es NO MEDIDO.
 *
 * La primera versión de esto trataba el `null` como 0, y con eso el defecto que esta clase existe
 * para matar reaparecía **una fila más arriba**: sin plan de costo de ventas,
 * `margen_bruto.plan = venta.plan − 0 = venta.plan`, o sea otra vez **100 % de margen**, ahora en
 * el renglón del margen en lugar del del resultado.
 *
 * Una resta no es una medición de lo que no se midió. Si falta un sumando, falta el total.
 */
const sub = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : round2(a - b);
const pct = (num: number | null, den: number | null): number | null =>
  num === null || den === null || den === 0 ? null : round2((num / den) * 100);
const cell = (plan: number | null, real: number | null): BudgetResultCell => ({ plan, real });

interface RealRow { ym: string; venta: number; costo: number; }
interface GastoRow { ym: string; gasto_op: number | null; fin_imp: number | null; compra: number | null; inversion: number | null; }

@Injectable()
export class BudgetResultService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async incomeStatement(budgetId: string): Promise<BudgetResult> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const budget = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!budget) throw new NotFoundException('Presupuesto no encontrado');
      const fy = Number(budget.fiscal_year);
      const from = `${fy}-01-01`;
      const to = `${fy}-12-31`;

      const planVenta = await this.planVentaPorMes(trx, tenantId, budgetId, fy);
      const planGasto = await this.planGastoPorMes(trx, tenantId, budgetId);
      const real = await this.realVenta(trx, tenantId, from, to);
      const gasto = await this.realGasto(trx, tenantId, from, to);
      const balanza = await this.balanzaGasto(trx, tenantId, fy);
      // `[VE.1]` El segundo testigo, el que NO comparte fuente primaria con nosotros.
      const libros = await this.arbitroIndependiente(trx, tenantId, fy);

      const months: BudgetResultMonth[] = [];
      for (let mm = 1; mm <= 12; mm++) {
        const ym = `${fy}-${String(mm).padStart(2, '0')}`;
        const r = real.get(ym);
        const g = gasto.get(ym);
        const pg = planGasto.get(ym);

        const venta = cell(planVenta.get(ym) ?? null, r ? round2(r.venta) : null);
        // ⛔ El plan del costo de ventas NO se inventa a partir del margen real: eso sería
        // presupuestar con el resultado, y además lo volvería imposible de incumplir.
        const costo = cell(null, r ? round2(r.costo) : null);
        const margen = cell(sub(venta.plan, costo.plan), sub(venta.real, costo.real));
        // ⚠️ Del lado REAL, un bucket vacío dentro de un mes QUE SÍ TIENE egresos es un cero de
        // negocio, no una ausencia: `sum() FILTER` devuelve NULL cuando ninguna póliza cayó en esa
        // familia, y eso significa «ese mes no hubo gasto financiero», no «no se sabe». En cambio
        // un mes sin NINGÚN egreso (`g` undefined) sí es NO MEDIDO. Del lado PLAN nunca se rellena:
        // ahí la ausencia siempre es «no hay presupuesto».
        const gastoOp = cell(pg?.gasto ?? null, g ? (g.gasto_op ?? 0) : null);
        const fin = cell(pg?.financieros ?? null, g ? (g.fin_imp ?? 0) : null);

        months.push({
          year_month: ym,
          venta,
          costo_ventas: costo,
          margen_bruto: margen,
          gasto_operativo: gastoOp,
          financieros: fin,
          // Sin plan de costo de ventas el resultado planeado NO existe. El guardia no va acá: lo
          // hace la resta estricta, para que el invariante viva en UN solo lugar y no en cada
          // renglón que alguien agregue después.
          resultado: cell(
            sub(sub(margen.plan, gastoOp.plan), fin.plan),
            sub(sub(margen.real, gastoOp.real), fin.real),
          ),
          margen_bruto_pct: cell(pct(margen.plan, venta.plan), pct(margen.real, venta.real)),
          cumplimiento_venta_pct: pct(venta.real, venta.plan),
          fuera_del_resultado: {
            compra_inventario: g?.compra ?? null,
            inversion: g?.inversion ?? null,
          },
        });
      }

      const col = (f: (m: BudgetResultMonth) => BudgetResultCell, lado: 'plan' | 'real') =>
        add(...months.map((m) => f(m)[lado]));
      const annualCell = (f: (m: BudgetResultMonth) => BudgetResultCell) => cell(col(f, 'plan'), col(f, 'real'));

      const aVenta = annualCell((m) => m.venta);
      const aCosto = annualCell((m) => m.costo_ventas);
      const aMargen = cell(sub(aVenta.plan, aCosto.plan), sub(aVenta.real, aCosto.real));
      const aGasto = annualCell((m) => m.gasto_operativo);
      const aFin = annualCell((m) => m.financieros);
      const annual: BudgetResultAnnual = {
        venta: aVenta,
        costo_ventas: aCosto,
        margen_bruto: aMargen,
        gasto_operativo: aGasto,
        financieros: aFin,
        resultado: cell(
          sub(sub(aMargen.plan, aGasto.plan), aFin.plan),
          sub(sub(aMargen.real, aGasto.real), aFin.real),
        ),
        margen_bruto_pct: cell(pct(aMargen.plan, aVenta.plan), pct(aMargen.real, aVenta.real)),
        compra_inventario: add(...months.map((m) => m.fuera_del_resultado.compra_inventario)),
        inversion: add(...months.map((m) => m.fuera_del_resultado.inversion)),
      };

      const hayPlanVenta = planVenta.size > 0;
      const hayPlanGasto = [...planGasto.values()].some((p) => p.gasto !== null || p.financieros !== null);
      const sources: BudgetResultSource[] = [
        {
          key: 'venta_plan', label: 'Meta de venta', source: 'budget.sales_plan_lines (13×4 → mes por días)',
          available: hayPlanVenta,
          reason: hayPlanVenta ? null : 'Sin plan de ventas propuesto para este ejercicio.',
        },
        {
          key: 'venta_real', label: 'Venta real', source: SALES_FACT,
          available: real.size > 0,
          reason: real.size > 0 ? null : 'El fact de venta no tiene filas del ejercicio.',
        },
        {
          key: 'costo_plan', label: 'Costo de ventas presupuestado', source: '—',
          available: false,
          reason: 'NO EXISTE presupuesto de costo de ventas. Es el renglón más grande del egreso '
            + '(medido ene–sep 2026: $416.0 M de costo contra $55.9 M de gasto operativo), y sin él '
            + 'el resultado planeado no se puede calcular — publicarlo sin este renglón es lo que '
            + 'daba «100 % de margen».',
        },
        {
          key: 'gasto_plan', label: 'Gasto presupuestado', source: 'budget.expense_plan_lines',
          available: hayPlanGasto,
          reason: hayPlanGasto ? null
            : 'Sin plan de gastos propuesto. El motor existe (ADR-073, se auto-propone desde '
              + 'Kepler); falta correrlo para este ejercicio.',
        },
        {
          key: 'gasto_real', label: 'Gasto real', source: 'analytics.expense_entries',
          available: gasto.size > 0,
          reason: gasto.size > 0 ? null : 'Sin egresos contables del ejercicio.',
        },
      ];

      const arbitros: BudgetResultArbitro[] = [
        this.arbitroGasto(annual.gasto_operativo.real, balanza),
        this.arbitroLibros(libros),
        {
          renglon: 'Venta',
          mio: annual.venta.real,
          arbitro: null,
          fuente_arbitro: 'analytics.ledger_monthly familia 4',
          delta: null,
          delta_pct: null,
          veredicto: 'no_comparable',
          nota: 'La balanza familia 4 incluye el traspaso interno del CEDIS a sus propias tiendas y '
            + 'rutas — el 84.49 % de la póliza de ingreso en agosto-2026 — y el fact de venta no. '
            + 'Restarlas daría una brecha que no es error de nadie: son universos distintos.',
        },
      ];

      const huecos: BudgetResultHueco[] = [
        {
          key: 'mapeo_fiscal_sin_firmar',
          label: 'La operación y los libros no están pareados concepto por concepto',
          monto: libros.kepler !== null && libros.contpaqi !== null
            ? round2(libros.contpaqi - libros.kepler) : null,
          nota: 'Kepler y ContPAQi usan planes de cuentas distintos; el único eje común es el '
            + 'agrupador SAT. Mientras Contabilidad no firme qué cuenta corresponde a qué '
            + 'agrupador, esta diferencia se puede VER pero no se le puede echar la culpa a ningún '
            + 'lado. Medido 2026: no es un factor constante — va de −7.2 % a −44.1 % según el '
            + 'bloque, así que no hay una sola causa.',
        },
        {
          key: 'costo_ventas_sin_plan',
          label: 'Costo de ventas sin presupuestar',
          monto: annual.costo_ventas.real,
          nota: 'Hay costo real y no hay meta contra qué compararlo. Mientras falte, el renglón '
            + '«Resultado» del plan queda en NO MEDIDO: es el único veredicto honesto.',
        },
        {
          key: 'compra_fuera',
          label: 'Compra de inventario — sale de caja y NO es resultado',
          monto: annual.compra_inventario,
          nota: 'Cuenta 511. Va al flujo de efectivo, no al estado de resultados. Se publica acá '
            + 'para que nadie la busque adentro del gasto y para que nadie la sume: hacerlo '
            + 'multiplica el gasto operativo por nueve.',
        },
        {
          key: 'inversion_fuera',
          label: 'Inversión (activo no circulante) — tampoco es resultado',
          monto: annual.inversion,
          nota: 'Cuenta 150. Mismo criterio que la compra: es flujo, no gasto del periodo.',
        },
      ];

      return {
        budget: { id: budget.id, name: budget.name, fiscal_year: fy, status: budget.status },
        from, to, months, annual, sources, arbitros, huecos,
        freshness: await this.freshness(trx),
      };
    });
  }

  // ── piernas ─────────────────────────────────────────────────────────────────────────────

  /**
   * Meta de venta por mes. El plan se captura en 13×4 y se reparte a meses **proporcional a los
   * días** del calendario, que es el mismo reparto que ya usa `projectToSalesTargets` (Fase PVT):
   * una sola regla, no dos.
   */
  private async planVentaPorMes(
    trx: Knex.Transaction, tenantId: string, budgetId: string, fy: number,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const lines = await trx('budget.sales_plan_lines')
      .where({ tenant_id: tenantId, budget_id: budgetId })
      .groupBy('period_no').select('period_no').sum({ meta: 'meta_amount' }) as unknown as
      Array<{ period_no: number | string; meta: number | string }>;
    if (!lines.length) return out;

    const { rows } = await trx.raw(
      `SELECT period_no, to_char(date, 'YYYY-MM') AS ym, count(*)::int AS days
         FROM analytics.v_retail_calendar WHERE fiscal_year = ?
        GROUP BY period_no, to_char(date, 'YYYY-MM')`, [fy]);
    const porPeriodo = new Map<number, Array<{ ym: string; days: number }>>();
    const diasPeriodo = new Map<number, number>();
    for (const r of rows as Array<{ period_no: number | string; ym: string; days: number | string }>) {
      const p = Number(r.period_no);
      if (!porPeriodo.has(p)) porPeriodo.set(p, []);
      porPeriodo.get(p)?.push({ ym: r.ym, days: Number(r.days) });
      diasPeriodo.set(p, (diasPeriodo.get(p) ?? 0) + Number(r.days));
    }
    for (const l of lines) {
      const p = Number(l.period_no);
      const meses = porPeriodo.get(p);
      const total = diasPeriodo.get(p) ?? 0;
      if (!meses || total <= 0) continue;        // periodo sin calendario: se omite, no se reparte a ciegas
      for (const m of meses) {
        out.set(m.ym, round2((out.get(m.ym) ?? 0) + Number(l.meta) * (m.days / total)));
      }
    }
    return out;
  }

  /** Gasto presupuestado por mes, separando gasto operativo (familia 6) de financieros (7). */
  private async planGastoPorMes(
    trx: Knex.Transaction, tenantId: string, budgetId: string,
  ): Promise<Map<string, { gasto: number | null; financieros: number | null }>> {
    const { rows } = await trx.raw(
      `SELECT year_month,
              sum(monto) FILTER (WHERE familia = '6') AS gasto,
              sum(monto) FILTER (WHERE familia = '7') AS financieros
         FROM budget.expense_plan_lines
        WHERE tenant_id = ? AND budget_id = ?
        GROUP BY year_month`, [tenantId, budgetId]);
    const out = new Map<string, { gasto: number | null; financieros: number | null }>();
    for (const r of rows as Array<{ year_month: string; gasto: string | null; financieros: string | null }>) {
      out.set(r.year_month, {
        gasto: r.gasto === null ? null : round2(Number(r.gasto)),
        financieros: r.financieros === null ? null : round2(Number(r.financieros)),
      });
    }
    return out;
  }

  /** Venta y costo reales, del fact arbitrado. Tenant explícito: `analytics.*` no siempre trae RLS. */
  private async realVenta(
    trx: Knex.Transaction, tenantId: string, from: string, to: string,
  ): Promise<Map<string, RealRow>> {
    const { rows } = await trx.raw(
      `SELECT to_char(sale_date, 'YYYY-MM') AS ym,
              sum(revenue)::numeric AS venta, sum(cost)::numeric AS costo
         FROM ${SALES_FACT}
        WHERE tenant_id = ? AND sale_date BETWEEN ?::date AND ?::date
        GROUP BY 1`, [tenantId, from, to]);
    return new Map((rows as Array<{ ym: string; venta: string; costo: string }>)
      .map((r) => [r.ym, { ym: r.ym, venta: Number(r.venta), costo: Number(r.costo) }]));
  }

  /**
   * Egreso real por mes, ya repartido en sus cuatro destinos.
   *
   * ⚠️ `cuenta_mayor = '511'` y no `familia = '5'`: la familia 5 de Kepler es la construcción
   * contable completa del costo de ventas (inventario inicial + compras − descuentos − inventario
   * final + el ajuste de traspasos internos), no la compra. Acá sólo interesa la compra, que es la
   * que sale de caja.
   */
  private async realGasto(
    trx: Knex.Transaction, tenantId: string, from: string, to: string,
  ): Promise<Map<string, GastoRow>> {
    const { rows } = await trx.raw(
      `SELECT to_char(fecha, 'YYYY-MM') AS ym,
              sum(importe) FILTER (WHERE familia = '6')        AS gasto_op,
              sum(importe) FILTER (WHERE familia = '7')        AS fin_imp,
              sum(importe) FILTER (WHERE cuenta_mayor = '511') AS compra,
              sum(importe) FILTER (WHERE cuenta_mayor = '150') AS inversion
         FROM analytics.expense_entries
        WHERE tenant_id = ? AND fecha BETWEEN ?::date AND ?::date
        GROUP BY 1`, [tenantId, from, to]);
    const num = (x: string | null) => (x === null ? null : round2(Number(x)));
    return new Map((rows as Array<Record<string, string | null>>).map((r) => [
      String(r['ym']),
      {
        ym: String(r['ym']),
        gasto_op: num(r['gasto_op']), fin_imp: num(r['fin_imp']),
        compra: num(r['compra']), inversion: num(r['inversion']),
      },
    ]));
  }

  /** El árbitro del gasto: la balanza, otra implementación del mismo hecho. */
  private async balanzaGasto(trx: Knex.Transaction, tenantId: string, fy: number): Promise<number | null> {
    const { rows } = await trx.raw(
      `SELECT sum(cargos - abonos)::numeric AS v
         FROM analytics.ledger_monthly
        WHERE tenant_id = ? AND familia = '6' AND anio_mes BETWEEN ? AND ?`,
      [tenantId, `${fy}-01`, `${fy}-12`]);
    const v = (rows as Array<{ v: string | null }>)[0]?.v;
    return v === null || v === undefined ? null : round2(Number(v));
  }

  /**
   * `[VE.1]` El árbitro **independiente**: los libros del contador, por `analytics.v_expense_arbiter`.
   *
   * ⚠️ Excluye el mes EN CURSO (`mes_en_curso`). Medido el 2026-10-06, día 6: incluirlo movía la
   * brecha de nómina de −$5,745,896 a −$2,582,497 —55 %— sin que pasara nada en el negocio, porque
   * los dos lados llenan el mes a ritmos distintos. Un acumulado que lo sume cambia todos los días.
   *
   * ⚠️ Y descarta las celdas con una sola pierna: ahí `delta` viene en NULL a propósito. Sumarlas
   * fue lo que hizo parecer que financieros estaba invertido.
   */
  private async arbitroIndependiente(
    trx: Knex.Transaction, tenantId: string, fy: number,
  ): Promise<{ kepler: number | null; contpaqi: number | null; meses: number; difieren: number }> {
    const { rows } = await trx.raw(
      `SELECT sum(kepler)::numeric                              AS kepler,
              sum(contpaqi)::numeric                            AS contpaqi,
              count(*)::int                                     AS meses,
              count(*) FILTER (WHERE veredicto = 'difiere')::int AS difieren
         FROM analytics.v_expense_arbiter
        WHERE tenant_id = ? AND anio_mes BETWEEN ? AND ?
          AND bloque IN ('nomina', 'gasto_resto')
          AND delta IS NOT NULL
          AND mes_en_curso = false`,
      [tenantId, `${fy}-01`, `${fy}-12`]);
    const r = (rows as Array<{ kepler: string | null; contpaqi: string | null; meses: number; difieren: number }>)[0];
    return {
      kepler: r?.kepler == null ? null : round2(Number(r.kepler)),
      contpaqi: r?.contpaqi == null ? null : round2(Number(r.contpaqi)),
      meses: Number(r?.meses ?? 0),
      difieren: Number(r?.difieren ?? 0),
    };
  }

  private arbitroLibros(
    v: { kepler: number | null; contpaqi: number | null; meses: number; difieren: number },
  ): BudgetResultArbitro {
    const base = {
      renglon: 'Gasto operativo (testigo independiente)',
      mio: v.kepler,
      arbitro: v.contpaqi,
      fuente_arbitro: 'analytics.v_expense_arbiter → contpaqi_ledger_monthly (los libros del contador)',
    };
    if (v.kepler === null || v.contpaqi === null || v.meses === 0) {
      return {
        ...base, delta: null, delta_pct: null, veredicto: 'no_medido' as const,
        nota: 'No hay meses terminados con las dos piernas en este ejercicio. No se afirma que '
          + 'cuadre ni que no.',
      };
    }
    const delta = round2(v.contpaqi - v.kepler);
    const deltaPct = pct(delta, v.contpaqi);
    return {
      ...base, delta, delta_pct: deltaPct,
      veredicto: v.difieren > 0 ? 'difiere' as const : 'cuadra' as const,
      nota: v.difieren > 0
        ? `A diferencia de la balanza, este testigo NO lee la misma tabla primaria: es la `
          + `contabilidad fiscal. Difiere en ${v.difieren} de ${v.meses} celdas medidas sobre meses `
          + 'terminados. ⚠️ Eso declara una BRECHA, no imputa un error: la correspondencia entre el '
          + 'plan de cuentas de Kepler y el agrupador SAT todavía no está firmada por Contabilidad, '
          + 'y sin ese pareo no se puede decir cuál de los dos lados tiene razón.'
        : 'La operación y los libros dicen lo mismo dentro del 0.5 % en todos los meses medidos.',
    };
  }

  private arbitroGasto(mio: number | null, arbitro: number | null): BudgetResultArbitro {
    const base = {
      renglon: 'Gasto operativo',
      mio, arbitro,
      // Se nombra lo que es: misma fuente primaria, otra derivación. Llamarlo «otra
      // implementación» a secas le prestaba una independencia que no tiene.
      fuente_arbitro: 'analytics.ledger_monthly familia 6 (misma fuente: kdc2YYMM)',
    };
    if (mio === null || arbitro === null) {
      return {
        ...base, delta: null, delta_pct: null, veredicto: 'no_medido' as const,
        nota: 'Falta una de las dos piernas en el ejercicio: no se afirma que cuadre ni que no.',
      };
    }
    const delta = round2(arbitro - mio);
    const deltaPct = pct(delta, arbitro);
    // 0.5 % es la banda con la que se midió ene–sep 2026: de abril en adelante el delta es de
    // centavos, y lo que la rompe (marzo, −15.26 %) es un hecho real que hay que poder ver.
    const cuadra = deltaPct !== null && Math.abs(deltaPct) <= 0.5;
    return {
      ...base, delta, delta_pct: deltaPct,
      veredicto: cuadra ? 'cuadra' : 'difiere',
      nota: cuadra
        ? 'El detalle por documento y la balanza dicen lo mismo dentro del 0.5 %.'
        : 'El detalle por documento y la balanza NO coinciden. Medido en 2026, la diferencia se '
          + 'concentra en ene–mar (de abril en adelante cuadra al centavo), así que revisar el '
          + 'arranque del ejercicio antes que el motor.',
    };
  }

  /**
   * ⚠️ La frescura sale del **latido de entrega** del refresco del fact, no de una columna de la
   * matvista: `mv_sales_blended.updated_at` es la fecha de venta truncada, no la marca del
   * refresco, y usarla diría «al día» siempre.
   */
  private async freshness(trx: Knex.Transaction) {
    try {
      return composeFreshness([
        evalInput(SALES_FACT_LANE, 'Fact de venta', await laneAt(trx, SALES_FACT_LANE), SALES_FACT_LANE_WARN_H),
      ]);
    } catch {
      return FRESHNESS_UNKNOWN;
    }
  }
}
