/* eslint-disable no-console */
/**
 * CP.2 (integración CB) — Smoke del crosswalk cuenta CB ↔ cuenta ContPAQi + comparación.
 * DB-direct (sin API). Valida que el schema tiene el enlace y que los datos LO SOPORTAN:
 * replica el match del servicio (familia de banco + account_label en el nombre) en memoria
 * (sin escribir) y que la comparación por periodo produce totales. Tolerante si no hay data.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

const RX = {
  SANTANDER: /santander|stder|stdr/i, BBVA: /bbva|bancomer/i,
  BANORTE: /banorte/i, BBAJIO: /bajio/i, BANAMEX: /banamex/i,
};

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    const hasCol = async (c) => (await knex.raw(
      `select 1 from information_schema.columns where table_schema='finance' and table_name='bank_accounts' and column_name=?`, [c])).rows.length > 0;
    ok(await hasCol('contpaqi_cuenta'), 'col finance.bank_accounts.contpaqi_cuenta');
    ok(await hasCol('contpaqi_cuenta_nombre'), 'col finance.bank_accounts.contpaqi_cuenta_nombre');

    const accounts = await knex('finance.bank_accounts').where('tenant_id', T)
      .select('bank', 'account_label', 'kind');
    const cpq = await knex('analytics.contpaqi_bank_movements').where('tenant_id', T)
      .select('cuenta', 'cuenta_nombre').count('* as movs').groupBy('cuenta', 'cuenta_nombre');

    if (!accounts.length || !cpq.length) {
      console.log('  ⚠ sin bank_accounts o sin ledger ContPAQi importado — skip aserciones de data');
    } else {
      ok(accounts.length >= 15, `cuentas de banco CB del tenant (${accounts.length})`);
      ok(cpq.length >= 5, `cuentas de banco distintas en ContPAQi (${cpq.length})`);

      // Replica el match del servicio (sin persistir).
      let linked = 0;
      const bankAccts = accounts.filter((a) => a.kind === 'bank');
      for (const a of bankAccts) {
        const rx = RX[a.bank];
        if (!rx) continue;
        const label = String(a.account_label).trim();
        const best = cpq.filter((c) => rx.test(c.cuenta_nombre || '') && String(c.cuenta_nombre).replace(/\D/g, '').includes(label))
          .sort((x, y) => Number(y.movs) - Number(x.movs))[0];
        if (best) linked++;
      }
      ok(linked >= 8, `cuentas de banco enlazables a ContPAQi (${linked}/${bankAccts.length})`);

      // Comparación por periodo: ContPAQi tiene totales para un mes reciente.
      const mes = (await knex('analytics.contpaqi_bank_movements').where('tenant_id', T)
        .max('anio_mes as m').first()).m;
      const t = await knex('analytics.contpaqi_bank_movements').where('tenant_id', T).andWhere('anio_mes', mes)
        .select(knex.raw(`SUM(importe) FILTER (WHERE flujo='deposito')::numeric dep`))
        .select(knex.raw(`SUM(importe) FILTER (WHERE flujo='retiro')::numeric ret`)).first();
      ok(Number(t.dep) > 0 && Number(t.ret) > 0, `ContPAQi tiene depósitos y retiros en ${mes} (dep ${Number(t.dep).toFixed(0)} / ret ${Number(t.ret).toFixed(0)})`);
    }

    console.log(`\nCP.2 ContPAQi bank link smoke: ${pass} OK, ${fail} fallidos`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
