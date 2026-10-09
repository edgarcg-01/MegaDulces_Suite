/**
 * `[PU.VG.6]` — **`fiscal_year` no es un periodo: el ejercicio no dice qué meses cubre.**
 *
 * `budget.budgets` guarda `fiscal_year` como un entero y **ninguna columna de ventana**. Los meses
 * cubiertos viven sólo en `expense_plan_lines.year_month`. Y las partidas materializadas traen
 * `period_month = NULL`, que en este esquema significa **«anual»**.
 *
 * ⛔ Medido en prod el 2026-10-08: **FY2026 «prueba 2» publica $32,425,843.06 con `period_month`
 * NULL en sus 12 partidas, y su plan cubre ago–dic: 5 de 12 meses.** Quien lo lea como un año
 * subestima ~58 %. No es que 5 meses esté mal —el sistema arrancó en agosto— : lo que está mal es
 * **publicarlo como anual**.
 *
 * ⭐⭐ LA DISTINCIÓN QUE ESTE CANDADO NO PUEDE BORRAR, y es la mitad del trabajo:
 *
 *   · el plan de **gasto** usa **12 meses naturales** (`year_month` = '2027-01' … '2027-12');
 *   · el plan de **ventas** usa los **13 periodos del calendario 13×4** (`period_no` 1…13).
 *
 * Los dos cubren el año entero. Marcar esa diferencia como «hueco» sería una **alarma falsa en
 * todos los ejercicios completos**, y una alarma que grita en falso enseña a ignorar el tablero
 * — que es exactamente cómo se pierde la señal real de FY2026. Por eso la cobertura del gasto se
 * mide contra **12**, nunca contra los periodos de ventas.
 *
 * READ-ONLY. Uso: PROD_DB_URL=... node database/tests/test-newdb-budget-ventana.js
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

(async () => {
  const c = new Client({ connectionString: URL, ssl: false, statement_timeout: 60000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  console.log(`destino: ${(await c.query('SELECT current_database() d')).rows[0].d} · READ-ONLY\n`);

  console.log('[1] el ejercicio no guarda su ventana — se deriva o no existe');
  const tieneVentana = (await c.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='budget' AND table_name='budgets'
      AND column_name IN ('period_from','period_to','starts_on','ends_on','desde','hasta')`)).rows;
  ok(tieneVentana.length === 0,
    `budget.budgets NO tiene columnas de ventana (encontradas: ${tieneVentana.length}) — fiscal_year es un entero, no un periodo`);

  console.log('\n[2] cobertura del plan de GASTO, contra 12 meses naturales');
  const budgets = (await c.query(`SELECT id, fiscal_year, name, is_test FROM budget.budgets ORDER BY fiscal_year, created_at`)).rows;
  const parciales = [];
  for (const b of budgets) {
    const g = (await c.query(`SELECT count(DISTINCT year_month)::int meses, min(year_month) a, max(year_month) z,
                                     coalesce(sum(monto),0) t
                                FROM budget.expense_plan_lines WHERE budget_id=$1`, [b.id])).rows[0];
    const meses = Number(g.meses);
    const pct = meses > 0 ? (meses / 12 * 100).toFixed(1) : 'n/d';
    console.log(`    FY${b.fiscal_year} «${String(b.name).slice(0, 26)}»${b.is_test ? ' [PRUEBA]' : ''}: ${meses}/12 meses (${pct}%) ${g.a || '—'} → ${g.z || '—'}  ${money(g.t)}`);
    if (meses > 0 && meses < 12) parciales.push({ b, g, meses });
  }
  ok(parciales.length > 0,
    `hay al menos un ejercicio PARCIAL que declarar (${parciales.length}) — si fueran 0, este candado no estaría midiendo nada`);

  console.log('\n[3] ⛔ un ejercicio parcial cuyas partidas dicen «anual»');
  for (const p of parciales) {
    const part = (await c.query(`SELECT count(*)::int n, count(*) FILTER (WHERE period_month IS NULL)::int anuales,
                                        coalesce(sum(vigente_amount),0) t
                                   FROM budget.budget_lines WHERE budget_id=$1 AND line_type='gasto'`, [p.b.id])).rows[0];
    console.log(`    FY${p.b.fiscal_year}: ${part.anuales} de ${part.n} partidas con period_month NULL («anual»), ${money(part.t)} sobre ${p.meses} meses`);
    ok(Number(part.anuales) === Number(part.n) && Number(part.n) > 0,
      `FY${p.b.fiscal_year}: la contradicción está completa — TODAS sus partidas se publican como anuales`);
    // El importe de la partida tiene que ser exactamente la suma de los meses que SÍ existen.
    ok(Math.abs(Number(part.t) - Number(p.g.t)) < 0.01,
      `FY${p.b.fiscal_year}: el importe publicado (${money(part.t)}) es la suma de sus ${p.meses} meses, no de doce`);
  }

  console.log('\n[4] ⭐ calendario ≠ cobertura: el gasto va en MESES y la venta en PERIODOS 13×4');
  for (const b of budgets) {
    const m = Number((await c.query(`SELECT count(DISTINCT year_month)::int n FROM budget.expense_plan_lines WHERE budget_id=$1`, [b.id])).rows[0].n);
    const p = Number((await c.query(`SELECT count(DISTINCT period_no)::int n FROM budget.sales_plan_lines WHERE budget_id=$1`, [b.id])).rows[0].n);
    if (m === 12 && p === 13) {
      ok(true, `FY${b.fiscal_year} «${String(b.name).slice(0, 18)}»: 12 meses de gasto vs 13 periodos de venta NO es un hueco — son dos calendarios y los dos cubren el año`);
    } else if (m > 0 && p > 0) {
      console.log(`    FY${b.fiscal_year} «${String(b.name).slice(0, 22)}»: ${m} meses de gasto · ${p} periodos de venta`);
    }
  }

  console.log('\n[5] lo que este candado NO afirma');
  nm('que 5 meses esté MAL: el sistema arrancó en agosto y un ejercicio parcial es legítimo. Lo que no es legítimo es publicarlo como anual');
  nm('cómo debe resolverse (partir las partidas por mes, o declarar la ventana en el ejercicio): es decisión de Dirección');

  await c.end();
  console.log(`\n${fail === 0 ? '✅ SIN FALLAS' : `❌ ${fail} FALLA(S)`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n❌ EXCEPCIÓN:', e.message); process.exit(1); });
