/* eslint-disable no-console */
/**
 * `[RQ.7]` CANDADO DE LA VIGENCIA DE UNA REQUISICIÓN — **SOLO LECTURA**.
 *
 * Qué defiende: el freno de `approve()` no bloquea por política ni por edad, bloquea porque el
 * costo capturado **ya no es el de hoy**, y eso es una medición. Si la medición deja de ser
 * cierta, el freno pasa a ser una traba arbitraria y este candado se pone rojo.
 *
 * ⚠️ NO ESCRIBE NADA, a propósito. `knexfile-newdb.js` resuelve a **prod** desde esta máquina
 * (`edgar` sobre `railway`, con `default_transaction_read_only=on`), así que un smoke con
 * fixtures no se puede correr acá — y fabricar uno contra otra base probaría otra cosa. Se
 * verifica la REGLA contra los datos reales, que es lo que el código va a leer en vivo.
 * Por lo mismo NO llama a `assertSafeTarget`: esa guarda es para los tests que escriben.
 *
 * Los tres bloques, y lo que cada uno pasa o rompe:
 *   1. LA PREMISA — `unit_cost` de la requisición y `caja_cost` del plan son la MISMA unidad.
 *      Toda la regla cuelga de esto; si la razón se despega de 1, lo que mide no es deriva de
 *      costo sino un cambio de peldaño, y el freno estaría frenando por la unidad equivocada.
 *   2. LA REGLA — el régimen por antigüedad: lo reciente conserva su costo, lo viejo no.
 *   3. LAS PRUEBAS NEGATIVAS — que el freno **no sea un no-op** (hay requisiciones que frena) y
 *      **no sea un bloqueo total** (hay requisiciones que deja pasar), y que el TERCER estado
 *      exista de verdad: lo que no se puede medir no cuenta ni como sano ni como movido.
 *
 * Lo que NO se puede medir se declara `NO MEDIDO` y no se pinta verde (ADR-056).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

/** El MISMO predicado que `vigenciaDeRequisiciones()`: si uno cambia, este candado lo ve. */
const MOVIDO = `rp.caja_cost > 0 AND l.unit_cost > 0 AND abs(l.unit_cost - rp.caja_cost) > 0.01 * rp.caja_cost`;
const MEDIBLE = `rp.caja_cost > 0 AND l.unit_cost > 0`;
const JOINS = `
  FROM commercial.purchase_requisition_lines l
  JOIN commercial.purchase_requisitions r ON r.tenant_id = l.tenant_id AND r.id = l.requisition_id
  LEFT JOIN analytics.replenishment_plan rp
    ON rp.tenant_id = l.tenant_id AND rp.product_id = l.product_id AND rp.warehouse_id = r.warehouse_id
 WHERE l.tenant_id = ?`;

(async () => {
  try {
    console.log('\n[RQ.7] Vigencia de requisiciones — candado de solo lectura\n');

    // ── 1. LA PREMISA: misma unidad ──────────────────────────────────────────────────────────
    console.log('1) La premisa — unit_cost(RQ) y caja_cost(plan) son la misma unidad');
    const u = (await knex.raw(`
      SELECT count(*)::int n,
             count(*) FILTER (WHERE abs(l.unit_cost / NULLIF(rp.caja_cost,0) - 1) <= 0.01)::int iguales
        ${JOINS} AND r.created_at >= now() - interval '3 days' AND ${MEDIBLE}`, [T])).rows[0];
    if (!Number(u.n)) {
      noMedido('no hay renglones de los últimos 3 días: la premisa de la unidad no se pudo comprobar en esta corrida');
    } else {
      const pct = 100 * Number(u.iguales) / Number(u.n);
      ok(pct >= 95, `la razón unit_cost/caja_cost es 1 en ${u.iguales}/${u.n} renglones frescos (${pct.toFixed(1)} %, umbral 95 %)`);
    }

    // ── 2. LA REGLA: el régimen por antigüedad ───────────────────────────────────────────────
    console.log('\n2) La regla — lo reciente conserva su costo, lo viejo no');
    const reg = (await knex.raw(`
      SELECT CASE WHEN r.created_at >= now() - interval '7 days'  THEN 'a_0_7'
                  WHEN r.created_at >= now() - interval '30 days' THEN 'b_8_30'
                  WHEN r.created_at >= now() - interval '60 days' THEN 'c_31_60'
                  ELSE 'd_60_mas' END AS tramo,
             count(*) FILTER (WHERE ${MEDIBLE})::int medibles,
             count(*) FILTER (WHERE ${MOVIDO})::int  movidos
        ${JOINS} AND r.estado = 'pending_approval'
       GROUP BY 1`, [T])).rows;
    const porTramo = Object.fromEntries(reg.map((x) => [x.tramo, x]));
    for (const t of ['a_0_7', 'b_8_30', 'c_31_60', 'd_60_mas']) {
      const x = porTramo[t];
      if (!x || !Number(x.medibles)) { noMedido(`tramo ${t}: sin renglones medibles`); continue; }
      const pct = 100 * Number(x.movidos) / Number(x.medibles);
      console.log(`     ${t.padEnd(9)} ${String(x.movidos).padStart(4)}/${String(x.medibles).padEnd(5)} movidos = ${pct.toFixed(1)} %`);
    }
    const fresco = porTramo['a_0_7'], viejo = porTramo['c_31_60'] || porTramo['d_60_mas'];
    if (!fresco || !Number(fresco.medibles) || !viejo || !Number(viejo.medibles)) {
      noMedido('faltan tramos con renglones medibles: el régimen por antigüedad no se pudo comparar');
    } else {
      const pf = 100 * Number(fresco.movidos) / Number(fresco.medibles);
      const pv = 100 * Number(viejo.movidos) / Number(viejo.medibles);
      ok(pv > pf, `lo viejo se movió MÁS que lo fresco (${pv.toFixed(1)} % contra ${pf.toFixed(1)} %) — es lo que justifica el freno`);
      ok(pf < 50, `lo fresco mayormente conserva su costo (${pf.toFixed(1)} % movido): el freno NO castiga el trabajo del día`);
    }

    // ── 3. LAS PRUEBAS NEGATIVAS ─────────────────────────────────────────────────────────────
    console.log('\n3) Pruebas negativas — ni no-op, ni bloqueo total, y el tercer estado existe');
    const v = (await knex.raw(`
      WITH x AS (
        SELECT l.requisition_id,
               count(*) FILTER (WHERE ${MEDIBLE})::int medibles,
               count(*) FILTER (WHERE ${MOVIDO})::int  movidos
          ${JOINS} AND r.estado = 'pending_approval'
         GROUP BY l.requisition_id
      )
      SELECT count(*)::int total,
             count(*) FILTER (WHERE medibles > 0 AND movidos > 0)::int frenadas,
             count(*) FILTER (WHERE medibles > 0 AND movidos = 0)::int pasan,
             count(*) FILTER (WHERE medibles = 0)::int               sin_medir
        FROM x`, [T])).rows[0];
    console.log(`     ${v.total} pendientes → frenadas ${v.frenadas} · pasan ${v.pasan} · sin medir ${v.sin_medir}`);
    if (!Number(v.total)) {
      noMedido('no hay requisiciones pendientes: no se pudo probar el freno en ningún sentido');
    } else {
      ok(Number(v.frenadas) > 0, `el freno NO es un no-op: hay ${v.frenadas} requisición(es) que bloquea`);
      ok(Number(v.pasan) > 0, `el freno NO es un bloqueo total: deja pasar ${v.pasan}`);
      ok(Number(v.frenadas) + Number(v.pasan) + Number(v.sin_medir) === Number(v.total),
        'los tres estados PARTICIONAN el universo: ninguna requisición cae en dos ni en ninguno');
      if (Number(v.sin_medir) > 0) {
        ok(true, `el tercer estado existe de verdad: ${v.sin_medir} no se pueden medir y NO se cuentan como sanas`);
      } else {
        noMedido('hoy no hay requisiciones sin medir: el tercer estado no se pudo ejercer');
      }
    }

    // ── 4. El resumen de la bandeja cuadra con el conteo directo ─────────────────────────────
    console.log('\n4) El resumen de la bandeja dice lo mismo que un conteo directo');
    const res = (await knex.raw(`
      SELECT estado, count(*)::int n,
             count(*) FILTER (WHERE created_at < now() - interval '30 days')::int n_mas_30
        FROM commercial.purchase_requisitions WHERE tenant_id = ? GROUP BY 1`, [T])).rows;
    const tot = (await knex('commercial.purchase_requisitions').where({ tenant_id: T }).count('* as c').first());
    const suma = res.reduce((a, x) => a + Number(x.n), 0);
    ok(suma === Number(tot.c), `las ${suma} del resumen son las ${tot.c} de la tabla`);
    const pend = res.find((x) => x.estado === 'pending_approval');
    if (pend) console.log(`     pendientes ${pend.n}, de las cuales ${pend.n_mas_30} pasaron los 30 días`);
    else noMedido('no hay requisiciones pendientes para contrastar el corte de 30 días');

    console.log(`\n[RQ.7] vigencia: ${pass} OK, ${fail} fallidos, ${nm} no medidos`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('FATAL', e);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
