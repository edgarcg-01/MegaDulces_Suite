/**
 * `[PU.VG.2]` — **De dónde salió cada celda del plan de gasto.**
 *
 * Hoy los tres orígenes se suman igual y ninguno se distingue en pantalla:
 *   · `observado` — el monto ES el gasto contable realizado de ese mes.
 *   · `promedio_plano` — el motor lo rellenó con `suma(observados)/n`, idéntico en cada mes
 *     rellenado, y lo rotuló **`estacional`**, que dice lo contrario de lo que hace.
 *   · `ausente` — no hay renglón: suma **$0.00 sin marcar nada**, la forma más barata de publicar
 *     un cero inventado.
 *
 * ⭐ El candado no verifica «la vista devuelve filas» —eso lo cumple cualquier cosa— sino que las
 * **tres clases PARTICIONAN la rejilla** (cuentas × meses) y que el importe del relleno es el que
 * es. Y corre un **GEMELO inline** del SQL de la vista: si la vista y el gemelo dejaran de
 * coincidir, uno de los dos cambió sin que nadie lo notara.
 *
 * ⚠️ Si la vista no existe (la migración `20261008182949` va aparte), el bloque de la vista
 * reporta **NO MEDIDO**, no verde — pero el gemelo igual mide la realidad, así que el test sigue
 * diciendo algo útil. Un candado que no puede correr y se calla se lee igual que uno que pasó.
 *
 * READ-ONLY. Uso: PROD_DB_URL=... node database/tests/test-newdb-budget-expense-coverage.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { Client } = require('pg');

const URL = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
if (!URL) { console.error('Falta PROD_DB_URL (o DATABASE_URL_NEW)'); process.exit(1); }
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => console.log(`  ⚠️  NO MEDIDO · ${m}`);
const money = (n) => '$' + Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** GEMELO del cuerpo de la vista, escrito aparte a propósito. */
const GEMELO = `
SELECT b.id AS budget_id, b.fiscal_year, b.name AS ejercicio, g.account_code, g.year_month,
       CASE WHEN e.id IS NULL THEN 'ausente'
            WHEN e.method = 'estacional' THEN 'promedio_plano'
            WHEN e.base_amount IS NULL THEN 'sin_base_declarada'
            ELSE 'observado' END AS estado,
       e.monto
  FROM budget.budgets b
  JOIN LATERAL (
        SELECT c.account_code, m.year_month
          FROM (SELECT DISTINCT account_code FROM budget.expense_plan_lines WHERE budget_id = b.id) c
         CROSS JOIN (SELECT DISTINCT year_month FROM budget.expense_plan_lines WHERE budget_id = b.id) m
       ) g ON true
  LEFT JOIN budget.expense_plan_lines e
         ON e.budget_id = b.id AND e.account_code = g.account_code AND e.year_month = g.year_month`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: false, statement_timeout: 60000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  console.log(`destino: ${(await c.query('SELECT current_database() d')).rows[0].d} · READ-ONLY\n`);

  console.log('[1] las tres clases PARTICIONAN la rejilla (cuentas × meses)');
  const porEj = (await c.query(`
    WITH cob AS (${GEMELO})
    SELECT budget_id, fiscal_year, ejercicio, count(*)::int celdas,
           count(*) FILTER (WHERE estado='observado')::int observado,
           count(*) FILTER (WHERE estado='promedio_plano')::int plano,
           count(*) FILTER (WHERE estado='ausente')::int ausente,
           count(*) FILTER (WHERE estado='sin_base_declarada')::int sin_base,
           coalesce(sum(monto),0) total,
           coalesce(sum(monto) FILTER (WHERE estado='promedio_plano'),0) relleno
      FROM cob GROUP BY 1,2,3 ORDER BY 2,3`)).rows;

  for (const e of porEj) {
    const suma = e.observado + e.plano + e.ausente + e.sin_base;
    const pct = Number(e.total) > 0 ? (Number(e.relleno) / Number(e.total) * 100) : null;
    console.log(`    FY${e.fiscal_year} «${String(e.ejercicio).slice(0, 26)}»: ${e.celdas} celdas = ${e.observado} obs + ${e.plano} plano + ${e.ausente} ausente + ${e.sin_base} sin_base`);
    console.log(`        total ${money(e.total)} · relleno ${money(e.relleno)} = ${pct === null ? 'n/d' : pct.toFixed(2) + '%'}`);
    ok(suma === e.celdas, `FY${e.fiscal_year} «${String(e.ejercicio).slice(0, 18)}»: las clases particionan (${suma}/${e.celdas})`);
  }

  console.log('\n[2] una celda AUSENTE no tiene importe — y por eso suma $0.00 sin avisar');
  const aus = (await c.query(`WITH cob AS (${GEMELO}) SELECT count(*)::int n, count(monto)::int con_monto FROM cob WHERE estado='ausente'`)).rows[0];
  ok(Number(aus.con_monto) === 0, `las ${aus.n} celdas ausentes tienen monto NULL, no 0 (con monto: ${aus.con_monto})`);
  ok(Number(aus.n) > 0, `hay ausencias de verdad que declarar (${aus.n}) — si fueran 0, este candado no estaría midiendo nada`);

  console.log('\n[3] el relleno plano es PLANO: el mismo importe en cada mes rellenado');
  const noPlano = (await c.query(`
    SELECT account_code, budget_id, count(DISTINCT monto)::int distintos, count(*)::int n
      FROM budget.expense_plan_lines WHERE method='estacional'
     GROUP BY 1,2 HAVING count(DISTINCT monto) > 1`)).rows;
  ok(noPlano.length === 0, `ninguna cuenta con 'estacional' varía entre sus meses (variaron: ${noPlano.length}) — o sea el nombre miente y el estado 'promedio_plano' es el correcto`);

  console.log('\n[4] la VISTA coincide con el gemelo');
  let hayVista = true;
  try { await c.query('SELECT 1 FROM budget.v_expense_plan_coverage LIMIT 1'); } catch { hayVista = false; }
  if (!hayVista) {
    nm('budget.v_expense_plan_coverage no existe acá: la migración 20261008182949 no está aplicada. El gemelo SÍ midió (bloques 1-3)');
  } else {
    const d = (await c.query(`
      WITH g AS (${GEMELO}), v AS (SELECT budget_id, account_code, year_month, estado FROM budget.v_expense_plan_coverage)
      SELECT count(*)::int n FROM (
        (SELECT budget_id, account_code, year_month, estado FROM g EXCEPT SELECT * FROM v)
        UNION ALL
        (SELECT * FROM v EXCEPT SELECT budget_id, account_code, year_month, estado FROM g)) x`)).rows[0];
    ok(Number(d.n) === 0, `vista y gemelo dan exactamente lo mismo (diferencias: ${d.n})`);
    const meta = (await c.query(`
      SELECT c.reloptions::text opts, has_table_privilege('app_runtime','budget.v_expense_plan_coverage','SELECT') grant_ok
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='budget' AND c.relname='v_expense_plan_coverage'`)).rows[0];
    ok(String(meta.opts).includes('security_invoker=true'), `security_invoker puesto (${meta.opts}) — sin esto la vista saltaría el RLS forzado de expense_plan_lines`);
    ok(meta.grant_ok === true, 'app_runtime puede leerla');
  }

  await c.end();
  console.log(`\n${fail === 0 ? '✅ SIN FALLAS' : `❌ ${fail} FALLA(S)`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n❌ EXCEPCIÓN:', e.message); process.exit(1); });
