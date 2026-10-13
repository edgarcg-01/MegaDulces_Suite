/* eslint-disable no-console */
/**
 * [PU.VG.10] — LA CONCENTRACION: cuanto del gasto de un ejercicio puede mover Direccion.
 * Smoke DB-direct, SOLO LECTURA (no abre transaccion, no escribe nada).
 *
 * POR QUE EXISTE ESTE ARCHIVO Y NO ALCANZA LA UNITARIA
 * ----------------------------------------------------
 * `budget-concentration.spec.ts` prueba la LOGICA con datos de juguete (16 aserciones, mutada a
 * rojo tres veces). Esto prueba otra cosa: que la logica, aplicada al dato REAL de prod, da el
 * mismo numero que una implementacion INDEPENDIENTE escrita en SQL con funciones de ventana.
 * Cruzar una implementacion consigo misma no valida nada.
 *
 *   - implementacion A (aqui, en SQL):  sum() OVER (ORDER BY ... ROWS UNBOUNDED PRECEDING)
 *   - implementacion B (el producto):   `concentracion` en TypeScript puro
 *
 * EL BORDE QUE IMPORTA: ?CUANTAS PARTIDAS HACEN EL 80%?
 * -----------------------------------------------------
 * Se cuenta la que CRUZA la linea, no la ultima que queda abajo. Medido en prod el 2026-10-09,
 * FY2027 acumula 79.46% en tres partidas: con la definicion "cuantas caben enteras abajo del 80"
 * la respuesta seria 3, y es justo el cuarto renglon el que Direccion tendria que tocar. Las dos
 * definiciones se calculan abajo y se COMPARAN, con prueba negativa: si dieran siempre lo mismo
 * este candado seria decorativo.
 *
 * EL OTRO BORDE: EL AGREGADO NO ES UN DATO
 * ----------------------------------------
 * Sumar FY2026 + FY2027 da "SUELDOS 53.90%", una cifra que no corresponde a ningun ano fiscal.
 * Hay un bloque que mide la diferencia contra el por-ejercicio para que quede por escrito cuanto
 * se deforma.
 *
 * LO QUE ESTE CANDADO NO PUEDE AFIRMAR
 * ------------------------------------
 * No verifica el endpoint HTTP (ADR-044): eso queda declarado, no fingido.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const path = require('path');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nomedido = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function nm(msg) { nomedido++; console.log('  ○ NO MEDIDO:', msg); }
const money = (n) => n == null ? '(null)' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Implementacion B: la del producto, cargada del fuente real. Si el modulo cambia, este candado
// mide el modulo nuevo -- que es exactamente lo que tiene que pasar.
let concentracion, fraseConcentracion;
try {
  // ts-node no esta garantizado en este runner: se compila el unico archivo que hace falta.
  const ts = require('typescript');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../../libs/finance/src/lib/budget/budget-concentration.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require);
  concentracion = mod.exports.concentracion;
  fraseConcentracion = mod.exports.fraseConcentracion;
} catch (e) {
  console.log('  (no se pudo cargar el modulo del producto:', e.message, ')');
}

/** Implementacion A: la concentracion, en SQL puro. */
async function concSQL(budgetId) {
  const r = await knex.raw(
    `WITH p AS (
       SELECT l.concept, l.original_amount::numeric amt
         FROM budget.budget_lines l
        WHERE l.tenant_id = ? AND l.budget_id = ? AND l.line_type = 'gasto'
          AND l.original_amount IS NOT NULL)
     SELECT concept, amt,
            round(100 * amt / NULLIF(sum(amt) OVER (), 0), 4) pct,
            round(100 * sum(amt) OVER (ORDER BY amt DESC, concept ASC ROWS UNBOUNDED PRECEDING)
                  / NULLIF(sum(amt) OVER (), 0), 4) acum
       FROM p ORDER BY amt DESC, concept ASC`, [T, budgetId]);
  return r.rows;
}

(async () => {
  try {
    await knex.raw('SET default_transaction_read_only = on');

    console.log('\n0. Guarda');
    let rechazo = null;
    try { await knex.raw('CREATE TEMP TABLE _conc_no_deberia (x int)'); } catch (e) { rechazo = e.code || e.message; }
    ok(rechazo !== null, `PRUEBA NEGATIVA: una escritura es RECHAZADA por el motor (${rechazo})`);

    const budgets = (await knex.raw(
      `SELECT id, fiscal_year, folio, is_test FROM budget.budgets
        WHERE tenant_id = ? AND is_test IS NOT TRUE ORDER BY fiscal_year DESC`, [T])).rows;
    if (!budgets.length) { nm('no hay ejercicios reales en esta base: nada que concentrar'); }

    for (const b of budgets) {
      console.log(`\n── FY${b.fiscal_year} (${b.folio || 'sin folio'}) ──`);
      const sql = await concSQL(b.id);
      const filasDb = (await knex.raw(
        `SELECT id, concept, account_code, original_amount, control_level, responsible, expense_class
           FROM budget.budget_lines WHERE tenant_id = ? AND budget_id = ? AND line_type = 'gasto'`,
        [T, b.id])).rows;

      if (!sql.length) { nm(`FY${b.fiscal_year} no tiene partidas de gasto con monto`); continue; }
      if (!concentracion) { nm('el modulo del producto no se pudo cargar: no hay con que cruzar'); continue; }

      const universo = { nombre: `el gasto de ${b.fiscal_year}`, completo: true };
      const ts = concentracion(filasDb, universo);
      const totalSql = Math.round(sql.reduce((a, r) => a + Number(r.amt), 0) * 100) / 100;

      console.log(`   total ${money(totalSql)} · ${sql.length} partidas · mayor ${sql[0].concept} ${sql[0].pct}%`);

      ok(ts.total === totalSql,
        `el total coincide al centavo entre SQL y TS (${money(totalSql)})`);
      ok(ts.filas.filter((f) => f.monto != null).map((f) => f.concepto).join('|') === sql.map((r) => r.concept).join('|'),
        'el ORDEN coincide renglon por renglon (desempate por concepto incluido)');
      ok(Math.abs(Number(sql[0].pct) - ts.pct_mayor) < 0.0001,
        `la partida mayor pesa lo mismo en las dos (${ts.pct_mayor}%)`);

      const acumOk = sql.every((r, i) => Math.abs(Number(r.acum) - ts.filas[i].acumulado) < 0.0001);
      ok(acumOk, 'el acumulado coincide en TODAS las filas, no solo en la primera');

      // ⭐ EL BORDE: las dos definiciones de "cuantas hacen el 80%".
      const cruza = sql.findIndex((r) => Number(r.acum) >= 80) + 1;      // la que CRUZA (la correcta)
      const debajo = sql.filter((r) => Number(r.acum) <= 80.0001).length; // las que caben abajo
      ok(ts.partidas_80 === cruza,
        `partidas que hacen el 80%: ${cruza} (la que CRUZA la linea; acumulado ${sql[cruza - 1].acum}%)`);
      if (cruza === debajo) {
        nm(`en FY${b.fiscal_year} las dos definiciones dan lo mismo (${cruza}): este ejercicio no distingue la correcta de la ingenua`);
      } else {
        ok(ts.partidas_80 !== debajo,
          `PRUEBA NEGATIVA: la definicion ingenua daria ${debajo} y no ${cruza} — las dos difieren, el criterio no es un no-op`);
      }

      // Cobertura: lo que falta capturar se cuenta, no se rellena.
      const cob = (await knex.raw(
        `SELECT count(*)::int partidas, count(responsible)::int con_resp, count(expense_class)::int con_clase,
                count(*) FILTER (WHERE control_level = 'bloqueo')::int con_freno
           FROM budget.budget_lines WHERE tenant_id = ? AND budget_id = ? AND line_type = 'gasto'`,
        [T, b.id])).rows[0];
      ok(ts.cobertura.partidas === cob.partidas && ts.cobertura.con_responsable === cob.con_resp
        && ts.cobertura.con_clase === cob.con_clase && ts.cobertura.con_freno_duro === cob.con_freno,
        `cobertura declarada = la real (resp ${cob.con_resp}/${cob.partidas} · clase ${cob.con_clase} · freno duro ${cob.con_freno})`);
      ok(ts.umbral_registrado === false, 'no emite veredicto: `umbral_registrado` es false');
    }

    console.log('\n── El agregado de los ejercicios NO es un dato ──');
    if (budgets.length < 2) {
      nm('hay un solo ejercicio real: la deformacion del agregado no se puede medir hoy');
    } else {
      const agg = (await knex.raw(
        `WITH p AS (SELECT l.concept, l.original_amount::numeric amt
                      FROM budget.budget_lines l JOIN budget.budgets b ON b.id = l.budget_id
                     WHERE l.tenant_id = ? AND l.line_type = 'gasto' AND b.is_test IS NOT TRUE)
         SELECT round(100 * max(amt) / sum(amt), 2) pct_mayor, sum(amt) total FROM p`, [T])).rows[0];
      const porEjercicio = await concSQL(budgets[0].id);
      const difer = Math.abs(Number(agg.pct_mayor) - Number(porEjercicio[0].pct));
      ok(difer > 0.5,
        `el agregado publica ${agg.pct_mayor}% donde el ejercicio real es ${porEjercicio[0].pct}% ` +
        `(${difer.toFixed(2)} pp de deformacion sobre ${money(agg.total)} que no son de ningun ano)`);
    }

    console.log('\n── [PU.VG.11] EL UNIVERSO ES PARTE DEL NUMERO ──');
    // La superficie de ingreso publicaba "4 de 8 entidades cargan el 81.6% del plan". Ese 81.6%
    // es de MOSTRADOR. Este bloque mide las DOS lecturas del MISMO hecho y exige que DIFIERAN: si
    // coincidieran, nombrar el universo seria decorativo y este candado no diria nada.
    const bi = budgets[0];
    const planRow = bi && (await knex.raw(
      `SELECT sum(original_amount)::numeric t FROM budget.budget_lines
         WHERE tenant_id = ? AND budget_id = ? AND line_type = 'ingreso'`, [T, bi.id])).rows[0];
    const most = bi ? (await knex.raw(
      `SELECT original_amount::numeric amt FROM budget.budget_lines
         WHERE tenant_id = ? AND budget_id = ? AND line_type = 'ingreso'
           AND cost_center LIKE 'mostrador:%' ORDER BY amt DESC`, [T, bi.id])).rows : [];

    if (!planRow || !Number(planRow.t) || most.length < 4) {
      nm('el ejercicio no tiene plan de ingreso por canal con 4+ renglones de mostrador: la leccion del universo no se puede ejercer con datos reales hoy');
    } else {
      const totalPlan = Number(planRow.t);
      const subMost = most.reduce((a, r) => a + Number(r.amt), 0);
      const top4 = most.slice(0, 4).reduce((a, r) => a + Number(r.amt), 0);
      const pctEnMostrador = 100 * top4 / subMost;
      const pctEnPlan = 100 * top4 / totalPlan;
      const fraccion = 100 * subMost / totalPlan;
      console.log(`   Mostrador ${money(subMost)} = ${fraccion.toFixed(2)}% del plan ${money(totalPlan)}`);
      console.log(`   las 4 mayores: ${pctEnMostrador.toFixed(2)}% de Mostrador  vs  ${pctEnPlan.toFixed(2)}% del plan`);
      ok(Math.abs(pctEnMostrador - pctEnPlan) > 1,
        `PRUEBA NEGATIVA: la misma cifra vale ${pctEnMostrador.toFixed(2)}% o ${pctEnPlan.toFixed(2)}% segun el universo ` +
        `(${(pctEnMostrador - pctEnPlan).toFixed(2)} pp): nombrar el universo NO es decorativo`);
      ok(fraccion < 99.5,
        `Mostrador es un RECORTE (${fraccion.toFixed(2)}% del plan): publicar su % como "del plan" sobredeclara`);

      if (concentracion && fraseConcentracion) {
        const recorte = { nombre: 'Mostrador', completo: false, de: 'el plan de ingreso', pct: Math.round(fraccion * 100) / 100 };
        const fr = fraseConcentracion(concentracion(most.map((r) => ({ concept: 'x', original_amount: r.amt })), recorte));
        ok(fr.detalle != null && fr.detalle.includes('del plan de ingreso'),
          `la frase del servidor CARGA la fraccion del recorte: "${fr.detalle}"`);
      }
    }

    console.log('\n── La frase la emite el SERVIDOR, no la plantilla ──');
    if (concentracion && fraseConcentracion && budgets.length) {
      const filasG = (await knex.raw(
        `SELECT id, concept, account_code, original_amount, control_level, responsible, expense_class
           FROM budget.budget_lines WHERE tenant_id = ? AND budget_id = ? AND line_type = 'gasto'`,
        [T, budgets[0].id])).rows;
      const cc = concentracion(filasG, { nombre: 'el gasto de ' + budgets[0].fiscal_year, completo: true });
      const fr = fraseConcentracion(cc);
      console.log('   titular: ' + fr.titular);
      console.log('   detalle: ' + fr.detalle);
      console.log('   inversa: ' + fr.inversa);
      ok(!fr.titular.includes('?') && !fr.titular.includes('\u00bf'),
        'el titular CONTESTA, no pregunta');
      ok(fr.titular.includes(String(budgets[0].fiscal_year)),
        'el titular NOMBRA el universo: sin eso la cifra no se puede defender');
      ok(fr.es_ausencia === (cc.total == null),
        'es_ausencia distingue un hecho de una ausencia declarada');
    } else {
      nm('el modulo del producto no se pudo cargar: la gramatica no se pudo ejercer');
    }

    console.log('\n── ¿EN QUE se diferencian el gasto y el ingreso? (correccion de Ventas) ──');
    // El doc afirmaba "el gasto esta concentrado y el ingreso no" sacandolo de "4 contra 9" --
    // un conteo ABSOLUTO sobre universos de 14 y 33 renglones. Medido: la FRACCION de renglones
    // que cruza el 80% es casi igual (28.6% vs 27.3%); lo que difiere es EL RENGLON DE ARRIBA
    // (55.50% vs 20.32%). Este bloque fija esa distincion para que la prosa no vuelva a derivar.
    const forma = {};
    for (const tipo of ['gasto', 'ingreso']) {
      const r = (await knex.raw(
        `SELECT original_amount::numeric amt FROM budget.budget_lines
           WHERE tenant_id = ? AND budget_id = ? AND line_type = ? AND original_amount IS NOT NULL
           ORDER BY amt DESC`, [T, budgets[0].id, tipo])).rows;
      if (!r.length) continue;
      const tot = r.reduce((a, x) => a + Number(x.amt), 0);
      if (!(tot > 0)) continue;
      let ac = 0, k = 0;
      for (const x of r) { ac += Number(x.amt); k++; if (100 * ac / tot >= 80) break; }
      forma[tipo] = { n: r.length, top1: 100 * Number(r[0].amt) / tot, fraccion: 100 * k / r.length, k };
    }

    if (!forma.gasto || !forma.ingreso) {
      nm('el ejercicio no tiene los dos lados cargados: la comparacion de forma no se puede medir hoy');
    } else {
      const g = forma.gasto, i = forma.ingreso;
      console.log(`   GASTO    top-1 ${g.top1.toFixed(2)}%   cruzan el 80%: ${g.k}/${g.n} = ${g.fraccion.toFixed(1)}% de los renglones`);
      console.log(`   INGRESO  top-1 ${i.top1.toFixed(2)}%   cruzan el 80%: ${i.k}/${i.n} = ${i.fraccion.toFixed(1)}% de los renglones`);
      const brechaTop1 = Math.abs(g.top1 - i.top1);
      const brechaForma = Math.abs(g.fraccion - i.fraccion);
      console.log(`   brecha en top-1: ${brechaTop1.toFixed(2)} pp   ·   brecha en forma: ${brechaForma.toFixed(2)} pp`);
      ok(brechaTop1 > brechaForma * 3,
        `la diferencia esta en EL RENGLON DE ARRIBA (${brechaTop1.toFixed(2)} pp), no en la forma de Pareto ` +
        `(${brechaForma.toFixed(2)} pp): la frase que se sostiene es "riesgo de punto unico en gasto", ` +
        'no "el gasto esta mas concentrado"');
      ok(g.top1 > i.top1,
        `el punto unico esta del lado del GASTO (${g.top1.toFixed(2)}% contra ${i.top1.toFixed(2)}%)`);
    }

    console.log('\n── El umbral que no existe ──');
    const umbrales = (await knex.raw(`SELECT count(*)::int n FROM analytics.kpi_thresholds`)).rows[0].n;
    ok(umbrales === 0,
      `analytics.kpi_thresholds sigue en ${umbrales} filas: por ADR-076 ningun semaforo seria legitimo (si esto se pone rojo, HAY umbrales y hay que revisar si alguno aplica al gasto)`);

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} no medido\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FALLO:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
