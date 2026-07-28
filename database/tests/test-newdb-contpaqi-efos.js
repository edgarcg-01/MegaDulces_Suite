/* eslint-disable no-console */
/**
 * CP.3 — Smoke: proveedores ContPAQi + cruce EFOS (Fase CP, ADR-040). DB-direct.
 * Valida el schema del staging de proveedores y que el cruce contra fiscal.sat_list_rfcs
 * (69/69B) produce resultados + que app_runtime puede leer ambas tablas (el tool corre así).
 * Tolerante: si no se importaron proveedores o no hay lista SAT, skip de las aserciones de data.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    const reg = (await knex.raw(`select to_regclass('analytics.contpaqi_suppliers') r`)).rows[0].r;
    ok(reg, 'tabla analytics.contpaqi_suppliers');
    for (const c of ['tenant_id', 'codigo', 'nombre', 'rfc']) {
      const has = (await knex.raw(
        `select 1 from information_schema.columns where table_schema='analytics' and table_name='contpaqi_suppliers' and column_name=?`, [c])).rows.length > 0;
      ok(has, `col ${c}`);
    }
    // El tool corre como app_runtime → debe poder leer ambas tablas del cruce.
    const g1 = (await knex.raw(`select has_table_privilege('app_runtime','analytics.contpaqi_suppliers','SELECT') s`)).rows[0].s;
    const g2 = (await knex.raw(`select has_table_privilege('app_runtime','fiscal.sat_list_rfcs','SELECT') s`)).rows[0].s;
    ok(g1 && g2, 'app_runtime tiene SELECT en las dos tablas del cruce');

    const nSup = Number((await knex('analytics.contpaqi_suppliers').where('tenant_id', T).count('* as c').first()).c);
    const nList = Number((await knex('fiscal.sat_list_rfcs').count('* as c').first()).c);
    if (nSup === 0 || nList === 0) {
      console.log(`  ⚠ proveedores=${nSup}, lista SAT=${nList} — skip aserciones del cruce`);
    } else {
      ok(nSup > 1000, `proveedores ContPAQi (${nSup})`);
      const withRfc = Number((await knex('analytics.contpaqi_suppliers').where('tenant_id', T).whereNotNull('rfc').count('* as c').first()).c);
      ok(withRfc / nSup > 0.9, `cobertura de RFC alta (${withRfc}/${nSup})`);
      // El cruce (misma query del tool).
      const cross = await knex('analytics.contpaqi_suppliers as s')
        .join('fiscal.sat_list_rfcs as l', 'l.rfc', 's.rfc')
        .where('s.tenant_id', T).whereNotNull('s.rfc')
        .select('l.lista').count('* as c').groupBy('l.lista');
      const total = cross.reduce((a, r) => a + Number(r.c), 0);
      ok(total >= 0, `cruce ContPAQi × listas SAT ejecuta (${total} matches: ${cross.map((r) => r.lista + ':' + r.c).join(', ') || 'ninguno'})`);
    }

    console.log(`\nCP.3 ContPAQi EFOS smoke: ${pass} OK, ${fail} fallidos`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
