/* eslint-disable no-console */
/**
 * CP.1 — Smoke de la balanza ContPAQi (Fase CP, ADR-040). DB-direct sobre la nueva DB
 * (NO toca el SQL Server de ContPAQi; valida lo YA importado en analytics.contpaqi_ledger_monthly).
 *
 * Cubre: schema (tabla + columnas + PK) · si hay data importada → cuadre Σcargos≈Σabonos,
 * formato anio_mes/periodo, neto=cargos−abonos, familias esperadas · aislamiento por tenant
 * (analytics sin RLS → filtro explícito: tenant falso ve 0). Tolerante: si no se corrió el
 * importer (0 filas), skip de las aserciones de data (no rompe CI offline).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const FAKE = '00000000-0000-0000-0000-0000000000ff';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    // ── 1. Schema ────────────────────────────────────────────────────────
    const reg = (await knex.raw(`select to_regclass('analytics.contpaqi_ledger_monthly') r`)).rows[0].r;
    ok(reg, 'tabla analytics.contpaqi_ledger_monthly');
    const hasCol = async (c) => (await knex.raw(
      `select 1 from information_schema.columns where table_schema='analytics' and table_name='contpaqi_ledger_monthly' and column_name=?`, [c])).rows.length > 0;
    for (const c of ['tenant_id', 'cuenta', 'ejercicio', 'periodo', 'anio_mes', 'cargos', 'abonos', 'neto', 'agrupador_sat'])
      ok(await hasCol(c), `col ${c}`);
    const pk = (await knex.raw(
      `select pg_get_constraintdef(oid) d from pg_constraint where conrelid='analytics.contpaqi_ledger_monthly'::regclass and contype='p'`)).rows[0];
    ok(pk && /tenant_id.*cuenta.*ejercicio.*periodo/s.test(pk.d), 'PK (tenant_id, cuenta, ejercicio, periodo)');

    // ── 2. Data (tolerante) ──────────────────────────────────────────────
    const n = Number((await knex('analytics.contpaqi_ledger_monthly').where('tenant_id', T).count('* as c').first()).c);
    if (n === 0) {
      console.log('  ⚠ sin data importada (corre import-contpaqi-ledger.js --apply) — skip aserciones de data');
    } else {
      ok(n > 1000, `filas del tenant (${n})`);

      const tot = await knex('analytics.contpaqi_ledger_monthly').where('tenant_id', T)
        .select(knex.raw('SUM(cargos)::numeric c'), knex.raw('SUM(abonos)::numeric a')).first();
      const dc = Number(tot.c), da = Number(tot.a);
      const rel = Math.abs(dc - da) / Math.max(Math.abs(dc), 1);
      ok(rel < 0.0001, `cuadre Σcargos≈Σabonos (C ${dc.toFixed(0)} vs A ${da.toFixed(0)}, Δrel ${(rel * 100).toFixed(5)}%)`);

      const bad = Number((await knex('analytics.contpaqi_ledger_monthly').where('tenant_id', T)
        .whereRaw('round((cargos - abonos)::numeric, 2) <> round(neto::numeric, 2)').count('* as c').first()).c);
      ok(bad === 0, `neto = cargos − abonos en todas las filas (${bad} inconsistentes)`);

      const fmt = Number((await knex('analytics.contpaqi_ledger_monthly').where('tenant_id', T)
        .whereRaw(`anio_mes !~ '^[0-9]{4}-[0-9]{1,2}$'`).count('* as c').first()).c);
      ok(fmt === 0, `formato anio_mes válido (${fmt} inválidos)`);

      const per = Number((await knex('analytics.contpaqi_ledger_monthly').where('tenant_id', T)
        .whereRaw('periodo < 1 OR periodo > 14').count('* as c').first()).c);
      ok(per === 0, `periodo en rango 1..14 (${per} fuera)`);

      const fams = (await knex('analytics.contpaqi_ledger_monthly').where('tenant_id', T)
        .distinct('familia').pluck('familia')).sort();
      ok(fams.includes('1') && fams.includes('5'), `familias contables presentes (${fams.join(',')})`);

      // ── 3. Aislamiento por tenant (analytics sin RLS → filtro explícito) ─
      const fk = Number((await knex('analytics.contpaqi_ledger_monthly').where('tenant_id', FAKE).count('* as c').first()).c);
      ok(fk === 0, 'tenant falso ve 0 filas (filtro explícito)');
    }

    console.log(`\nCP.1 ContPAQi balanza smoke: ${pass} OK, ${fail} fallidos`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
