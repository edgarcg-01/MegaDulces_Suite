/**
 * `[PU.VG.5]` — **El esquema declara un freno que no existe.**
 *
 * `control_level` decide qué pasa con un sobregiro: `bloqueo` lo rechaza, `advertencia` lo deja
 * pasar con aviso, `informativo` ni eso (`budget-lines.service.ts`).
 *
 * ⭐ Lo medido en prod el 2026-10-08, y lo primero que tumbó la lectura fácil: **cero partidas en
 * `bloqueo`**, pero NO porque alguien lo haya bajado. El **DEFAULT de la columna dice `'bloqueo'`
 * y nunca se usa**: `materialize` siempre pasa un valor explícito, y para el gasto ese valor sale
 * de `expense_plan_settings.control_level` —cuyo propio default es `'advertencia'`— sobre una
 * tabla con **cero filas**, así que en los hechos manda el literal `|| 'advertencia'` del código.
 *
 * O sea: quien lea la migración de `budget_lines` va a creer que las partidas nacen bloqueadas.
 * Hay **dos lugares** decidiendo lo mismo y el que gana no es el que el esquema anuncia.
 *
 * ⛔ Este candado **no decide** cuál debe ser el nivel —poner `bloqueo` cambia la operación y es
 * decisión de Dirección—: afirma la CONTRADICCIÓN y mide la exposición (ADR-056).
 *
 * ⚠️ Mide sólo el EGRESO. Un ingreso es meta, no tope de gasto, y `informativo` ahí es correcto;
 * mezclarlos daría un número que suena grave y no significa nada.
 *
 * READ-ONLY. Uso: PROD_DB_URL=... node database/tests/test-newdb-budget-frenos.js
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

  console.log('[1] los dos lugares que deciden el mismo nivel, y cuál gana');
  const dCol = (await c.query(`SELECT column_default FROM information_schema.columns
    WHERE table_schema='budget' AND table_name='budget_lines' AND column_name='control_level'`)).rows[0];
  const dSet = (await c.query(`SELECT column_default FROM information_schema.columns
    WHERE table_schema='budget' AND table_name='expense_plan_settings' AND column_name='control_level'`)).rows[0];
  const nSet = (await c.query(`SELECT count(*)::int n FROM budget.expense_plan_settings`)).rows[0].n;
  console.log(`    budget_lines.control_level          DEFAULT ${dCol?.column_default}`);
  console.log(`    expense_plan_settings.control_level DEFAULT ${dSet?.column_default}  ·  filas: ${nSet}`);
  ok(String(dCol?.column_default ?? '').includes('bloqueo'),
    'el esquema de budget_lines SIGUE anunciando bloqueo por default (si esto cambia, actualizá el relato de abajo)');

  console.log('\n[2] ⭐ ese default NO se aplica nunca: la contradicción, medida');
  const niveles = (await c.query(`
    SELECT line_type, control_level, count(*)::int partidas, coalesce(sum(vigente_amount),0) importe
      FROM budget.budget_lines GROUP BY 1,2 ORDER BY 1,2`)).rows;
  for (const r of niveles) console.log(`    ${r.line_type.padEnd(10)} ${r.control_level.padEnd(13)} ${String(r.partidas).padStart(4)} partidas  ${money(r.importe)}`);
  const conBloqueo = niveles.filter((r) => r.control_level === 'bloqueo').reduce((a, r) => a + r.partidas, 0);
  ok(conBloqueo === 0,
    `cero partidas nacieron con el default del esquema (con bloqueo: ${conBloqueo}) — materialize siempre pasa valor explícito`);

  console.log('\n[3] el ingreso en informativo es CORRECTO, no parte del problema');
  const ingMal = niveles.filter((r) => r.line_type === 'ingreso' && r.control_level !== 'informativo');
  ok(ingMal.length === 0, `ninguna partida de ingreso pretende ser tope de gasto (anómalas: ${ingMal.length})`);

  console.log('\n[4] la exposición: egreso autorizado SIN freno duro');
  const g = niveles.filter((r) => r.line_type === 'gasto');
  const sinFreno = g.filter((r) => r.control_level !== 'bloqueo');
  const totalSin = sinFreno.reduce((a, r) => a + Number(r.importe), 0);
  const totalG = g.reduce((a, r) => a + Number(r.importe), 0);
  console.log(`    gasto total ${money(totalG)} · sin freno duro ${money(totalSin)} (${totalG > 0 ? (totalSin / totalG * 100).toFixed(2) : 'n/d'}%)`);

  // ⚠️ El total de arriba incluye los ejercicios de PRUEBA. La cifra que se publica tiene que
  // excluirlos, o el duplicado FY2027 la infla al doble (ver [PU.VG.1]).
  const colIsTest = (await c.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='budget' AND table_name='budgets' AND column_name='is_test'`)).rows.length === 1;
  if (!colIsTest) {
    nm('budget.budgets.is_test no existe acá: la exposición de arriba incluye ejercicios de prueba y puede venir inflada');
  } else {
    const real = (await c.query(`
      SELECT coalesce(sum(l.vigente_amount),0) t, count(*)::int n
        FROM budget.budget_lines l JOIN budget.budgets b ON b.id = l.budget_id
       WHERE l.line_type='gasto' AND l.control_level <> 'bloqueo' AND b.is_test = false`)).rows[0];
    console.log(`    excluyendo ejercicios de prueba: ${money(real.t)} en ${real.n} partidas`);
    ok(Number(real.t) <= totalSin, 'la cifra sin ejercicios de prueba no puede ser mayor que la bruta');
    ok(Number(real.n) > 0, 'hay egreso real expuesto que declarar — si fuera 0, este candado no mediría nada');
  }

  console.log('\n[5] lo que este candado NO afirma');
  nm('cuál DEBE ser el nivel: poner bloqueo rechaza sobregiros y cambia la operación. Es decisión de Dirección, no de un test');

  await c.end();
  console.log(`\n${fail === 0 ? '✅ SIN FALLAS' : `❌ ${fail} FALLA(S)`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n❌ EXCEPCIÓN:', e.message); process.exit(1); });
