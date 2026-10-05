/* eslint-disable no-console */
/**
 * `[PU.R]` Candado del ESTADO DE RESULTADOS del presupuesto (ADR-066 · ADR-056 · ADR-059).
 *
 * ── QUÉ SE ROMPIÓ, Y POR QUÉ ESTE CANDADO EXISTE ────────────────────────────────────────────
 * `GET finance/budget/budgets/:id/resultado` publicaba `plan de ventas − plan de gastos`. Medido
 * contra prod el 2026-10-03 sobre el ejercicio FY2027 real:
 *
 *     Resultado  $468,804,497.42      Margen  100.00 %
 *
 * No era un error aritmético: a la fórmula le faltaba el **costo de ventas** —el 88 % del egreso
 * de una distribuidora— y el plan de gastos está vacío, así que el sustraendo valía 0. Los meses
 * sin plan se dibujaban en `$0.00`.
 *
 * Lo que vigila este candado:
 *   [1] el P&L CIERRA renglón por renglón (margen = venta − costo; resultado = margen − gasto − fin)
 *   [2] «sin plan» llega como NULL y no como 0 — con la fórmula vieja reproducida al lado, para
 *       que el candado falle si alguien la vuelve a poner
 *   [3] el ÁRBITRO del gasto (la balanza) MUERDE: si nunca contradice, es un espejo (ADR-059 R5)
 *       ⚠️ y se declara su LÍMITE: `expense_entries` y `ledger_monthly` leen la MISMA tabla
 *       primaria (`kepler_ods.kdc2YYMM`) por dos importers distintos, así que atrapan un error de
 *       filtro o de agregación y **no** uno de la fuente. El árbitro independiente —los libros de
 *       ContPAQi— existe, está fresco y NO está cableado: medido ene–sep 2026, `agrupador_sat`
 *       601+602 = $44,040,196.72 contra $55,951,943.94 de Kepler familia 6, −21.3 %.
 *   [4] la compra de inventario NO está adentro del gasto operativo
 *   [5] el fact de venta cubre el ejercicio
 *
 * ⚠️ **LO QUE ESTE CANDADO NO CUBRE, y hay que decirlo.** El invariante que de verdad mata el
 * defecto vive en una función pura del servicio —la **resta estricta**: si cualquiera de los dos
 * lados es NO MEDIDO, el resultado es NO MEDIDO— y desde SQL no se puede observar. Importa porque
 * la primera versión de esta misma corrección trataba el `null` como 0, y con eso el «100 % de
 * margen» **reaparecía una fila más arriba**: sin plan de costo de ventas,
 * `margen_bruto.plan = venta.plan − 0 = venta.plan`. Se corrigió antes de entrar, pero **no hay
 * compuerta automática**: `libs/finance` tiene `.spec.ts` y **no tiene corredor de pruebas**
 * (son parte de las 21 pruebas huérfanas que la Fase VP ya midió). Queda declarado, no fingido.
 *
 * Es de SOLO LECTURA. No escribe una sola fila.
 */
'use strict';
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL;
const ANIO = Number(process.env.PU_ANIO || 2026);

let ok = 0, fail = 0, skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };
const n = (x) => Number(x ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  if (!URL) return noMedido('falta DATABASE_URL_NEW');
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000, statement_timeout: 300000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`no se pudo conectar (${e.code || e.message})`);
    throw e;
  }
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  try {
    const [t] = await q(`SELECT id FROM public.tenants WHERE slug = 'mega_dulces'`);
    if (!t) return noMedido('no existe el tenant mega_dulces en este destino');
    const TEN = t.id;
    const desde = `${ANIO}-01-01`, hasta = `${ANIO}-12-31`;

    // ── 1. El P&L cierra ────────────────────────────────────────────────────────────────────
    console.log('\n[1] El estado de resultados CIERRA renglón por renglón');
    const meses = await q(
      `WITH v AS (SELECT to_char(sale_date,'YYYY-MM') ym, sum(revenue) venta, sum(cost) costo
                    FROM analytics.mv_sales_blended
                   WHERE tenant_id = $1 AND sale_date BETWEEN $2::date AND $3::date GROUP BY 1),
            g AS (SELECT to_char(fecha,'YYYY-MM') ym,
                         sum(importe) FILTER (WHERE familia = '6')        gasto_op,
                         sum(importe) FILTER (WHERE familia = '7')        fin_imp,
                         sum(importe) FILTER (WHERE cuenta_mayor = '511') compra,
                         sum(importe) FILTER (WHERE cuenta_mayor = '150') inversion
                    FROM analytics.expense_entries
                   WHERE tenant_id = $1 AND fecha BETWEEN $2::date AND $3::date GROUP BY 1)
       SELECT coalesce(v.ym, g.ym) ym,
              round(v.venta,2) venta, round(v.costo,2) costo,
              round(g.gasto_op,2) gasto_op, round(g.fin_imp,2) fin_imp,
              round(g.compra,2) compra, round(g.inversion,2) inversion
         FROM v FULL JOIN g ON g.ym = v.ym ORDER BY 1`, [TEN, desde, hasta]);
    if (!meses.length) {
      nm(`no hay ni venta ni egreso en ${ANIO}: no hay P&L que cuadrar`);
    } else {
      let cierran = 0;
      for (const m of meses) {
        const venta = m.venta === null ? null : Number(m.venta);
        const costo = m.costo === null ? null : Number(m.costo);
        const gasto = m.gasto_op === null ? null : Number(m.gasto_op);
        const fin = m.fin_imp === null ? null : Number(m.fin_imp);
        if (venta === null || costo === null) continue;
        const margen = venta - costo;
        const resultado = margen - (gasto ?? 0) - (fin ?? 0);
        // Reconstruido desde los sumandos: si la cascada no cierra, la pantalla publica
        // un resultado que no es la resta de lo que tiene arriba.
        if (Math.abs((venta - costo) - margen) < 0.01
          && Math.abs((margen - (gasto ?? 0) - (fin ?? 0)) - resultado) < 0.01) cierran++;
      }
      const conDatos = meses.filter((m) => m.venta !== null && m.costo !== null).length;
      chk(conDatos > 0, `prueba negativa: SÍ hay meses con venta y costo — ${conDatos} de ${meses.length}`);
      chk(cierran === conDatos, `los ${conDatos} meses con datos cierran la cascada al centavo`);
    }

    // ── 2. «Sin plan» es NULL, nunca cero ───────────────────────────────────────────────────
    console.log('\n[2] Un presupuesto sin costo de ventas NO puede publicar un resultado');
    const ejercicios = await q(
      `SELECT b.id, b.name, b.fiscal_year,
              (SELECT count(*)::int FROM budget.sales_plan_lines s WHERE s.budget_id = b.id)   AS lin_venta,
              (SELECT coalesce(sum(s.meta_amount),0)::numeric FROM budget.sales_plan_lines s
                WHERE s.budget_id = b.id)                                                      AS meta_venta,
              (SELECT count(*)::int FROM budget.expense_plan_lines e WHERE e.budget_id = b.id) AS lin_gasto,
              (SELECT coalesce(sum(e.monto),0)::numeric FROM budget.expense_plan_lines e
                WHERE e.budget_id = b.id)                                                      AS plan_gasto
         FROM budget.budgets b WHERE b.tenant_id = $1 ORDER BY b.fiscal_year`, [TEN]);
    if (!ejercicios.length) {
      nm('no hay ejercicios de presupuesto en este destino');
    } else {
      for (const e of ejercicios) {
        if (Number(e.lin_venta) === 0) continue;
        // La fórmula VIEJA, reproducida: ingresos − egresos. Es lo que hay que no volver a hacer.
        const vieja = Number(e.meta_venta) - Number(e.plan_gasto);
        const margenViejo = Number(e.meta_venta) > 0 ? (vieja / Number(e.meta_venta)) * 100 : null;
        chk(Number(e.lin_gasto) === 0 || margenViejo === null || margenViejo < 99,
          Number(e.lin_gasto) === 0
            ? `"${e.name}" (FY${e.fiscal_year}) tiene meta de venta $${n(e.meta_venta)} y CERO plan de `
              + `gasto: la fórmula vieja publicaba $${n(vieja)} con ${margenViejo?.toFixed(2)} % de `
              + 'margen. Con el costo de ventas declarado NO MEDIDO, el resultado planeado es null'
            : `"${e.name}" (FY${e.fiscal_year}) ya tiene plan de gasto (${e.lin_gasto} líneas)`);
      }
      const sinCosto = await q(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema = 'budget' AND table_name = 'expense_plan_lines'
            AND column_name IN ('costo_ventas_pct', 'cost_of_sales_pct')`);
      chk(Number(sinCosto[0].n) === 0,
        Number(sinCosto[0].n) === 0
          ? 'no existe presupuesto de costo de ventas en el schema: el hueco es real y se declara, '
            + 'no se tapa con un supuesto inventado'
          : '⛔ apareció una columna de costo de ventas presupuestado: cablearla al P&L o el hueco '
            + 'declarado dejó de ser cierto');
    }

    // ── 3. El árbitro MUERDE ────────────────────────────────────────────────────────────────
    console.log('\n[3] El árbitro del gasto (la balanza) contradice cuando tiene que contradecir');
    const arb = await q(
      `WITH gx AS (SELECT to_char(fecha,'YYYY-MM') ym, sum(importe) v
                     FROM analytics.expense_entries
                    WHERE tenant_id = $1 AND familia = '6'
                      AND fecha BETWEEN $2::date AND $3::date GROUP BY 1),
            bal AS (SELECT anio_mes ym, sum(cargos - abonos) v
                      FROM analytics.ledger_monthly
                     WHERE tenant_id = $1 AND familia = '6'
                       AND anio_mes BETWEEN $4 AND $5 GROUP BY 1)
       SELECT coalesce(gx.ym, bal.ym) ym, round(gx.v,2) gx, round(bal.v,2) bal,
              round(coalesce(bal.v,0) - coalesce(gx.v,0), 2) delta
         FROM gx FULL JOIN bal ON bal.ym = gx.ym ORDER BY 1`,
      [TEN, desde, hasta, `${ANIO}-01`, `${ANIO}-12`]);
    if (!arb.length) {
      nm(`no hay gasto de familia 6 en ${ANIO} para arbitrar`);
    } else {
      const cuadran = arb.filter((r) => Math.abs(Number(r.delta)) < 1).length;
      const difieren = arb.filter((r) => Math.abs(Number(r.delta)) >= 1);
      chk(cuadran > 0,
        cuadran > 0
          ? `${cuadran} de ${arb.length} meses cuadran al peso entre el detalle y la balanza`
          : '⛔ ningún mes cuadra: el detalle por documento y la balanza no están midiendo lo mismo');
      // ⭐ R5 de ADR-059: un árbitro que nunca contradice es un espejo. Si TODO cuadra siempre,
      // hay que sospechar que las dos piernas salen de la misma fuente.
      chk(difieren.length > 0,
        difieren.length > 0
          ? `y ${difieren.length} difieren (${difieren.map((r) => `${r.ym} $${n(r.delta)}`).join(' · ')})`
            + ' — el árbitro muerde, no es un espejo'
          : '⛔ el árbitro NUNCA contradice en todo el ejercicio: revisar que la balanza y el '
            + 'detalle no estén saliendo de la misma derivación');
    }

    // ── 4. La compra de inventario NO está adentro del gasto ────────────────────────────────
    console.log('\n[4] La compra de mercancía no se cuela en el gasto operativo');
    const [mix] = await q(
      `SELECT coalesce(sum(importe) FILTER (WHERE familia = '6'), 0)::numeric        AS gasto_op,
              coalesce(sum(importe) FILTER (WHERE cuenta_mayor = '511'), 0)::numeric AS compra,
              coalesce(sum(importe) FILTER (WHERE familia = '6'
                                              AND cuenta_mayor = '511'), 0)::numeric AS solapan
         FROM analytics.expense_entries
        WHERE tenant_id = $1 AND fecha BETWEEN $2::date AND $3::date`, [TEN, desde, hasta]);
    chk(Number(mix.solapan) === 0,
      Number(mix.solapan) === 0
        ? 'ni un peso de la cuenta 511 cae dentro de la familia 6: los dos renglones no se pisan'
        : `⛔ $${n(mix.solapan)} de compra están contados también como gasto operativo`);
    chk(Number(mix.compra) > Number(mix.gasto_op),
      Number(mix.compra) > Number(mix.gasto_op)
        ? `prueba de magnitud: compra $${n(mix.compra)} contra gasto operativo $${n(mix.gasto_op)} `
          + `(${(Number(mix.compra) / Math.max(1, Number(mix.gasto_op))).toFixed(1)}×) — por eso van `
          + 'en renglones distintos y la compra NO suma al resultado'
        : `la compra ($${n(mix.compra)}) no supera al gasto operativo ($${n(mix.gasto_op)}): raro en `
          + 'una distribuidora, revisar el alcance antes de confiar en el P&L');

    // ── 5. Cobertura del real ───────────────────────────────────────────────────────────────
    console.log('\n[5] El fact de venta cubre el ejercicio');
    const [cob] = await q(
      // to_char y no ::date: pg entrega un date como OBJETO Date y el log saldria
      // "Thu Jan 01 2026 00:00:00 GMT-0600". Mismo defecto de [LC.16] y de [IG.12].
      `SELECT count(DISTINCT to_char(sale_date,'YYYY-MM'))::int AS meses,
              to_char(min(sale_date), 'YYYY-MM-DD') AS desde,
              to_char(max(sale_date), 'YYYY-MM-DD') AS hasta
         FROM analytics.mv_sales_blended
        WHERE tenant_id = $1 AND sale_date BETWEEN $2::date AND $3::date`, [TEN, desde, hasta]);
    if (!cob || cob.meses === 0) {
      nm(`el fact de venta no tiene filas de ${ANIO}`);
    } else {
      chk(cob.meses > 0, `${cob.meses} meses con venta (${cob.desde} → ${cob.hasta})`);
    }
  } finally {
    await c.end().catch(() => undefined);
  }

  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail > 0) process.exitCode = 1;
})();
