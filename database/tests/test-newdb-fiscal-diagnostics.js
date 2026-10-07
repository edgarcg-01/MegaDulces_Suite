/* eslint-disable no-console */
/**
 * FD.0/FD.2 — Smoke del Diagnóstico de facturación.
 * Verifica: schema + RLS forzado de fiscal.emission_errors, el fix del bug FE.10
 * (estatus_sat acepta 'en_proceso_cancelacion'/'rechazado' y rechaza basura), y la
 * captura idempotente por (tenant, dedup_key) con auto-reapertura al re-fallar.
 * DB-direct, en UNA transacción con ROLLBACK (no persiste).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const UPSERT = `
  INSERT INTO fiscal.emission_errors (tenant_id, kind, dedup_key, status, error_message, pac_code)
  VALUES (?, ?, ?, 'open', ?, ?)
  ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET
    status='open', resolved_at=NULL, error_message=EXCLUDED.error_message, pac_code=EXCLUDED.pac_code,
    attempts=fiscal.emission_errors.attempts + 1, last_seen_at=now(), updated_at=now()
  RETURNING (xmax = 0) AS es_nuevo, attempts, status`;

(async () => {
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // 1. Schema + RLS
      const tbls = (await trx.raw(`select table_name from information_schema.tables where table_schema='fiscal'`)).rows.map(r => r.table_name);
      ok(tbls.includes('emission_errors'), 'tabla fiscal.emission_errors existe');
      const rls = (await trx.raw(`select relforcerowsecurity f from pg_class where relname='emission_errors' and relnamespace='fiscal'::regnamespace`)).rows[0];
      ok(rls && rls.f === true, 'RLS FORZADO en fiscal.emission_errors');

      // 2. Fix bug FE.10 — estatus_sat acepta los nuevos valores
      await trx('fiscal.cfdis').insert({ tenant_id: T, uuid: 'FD-EST-PROC', estatus_sat: 'en_proceso_cancelacion' });
      ok(true, "estatus_sat acepta 'en_proceso_cancelacion' (bug FE.10 corregido)");
      await trx('fiscal.cfdis').insert({ tenant_id: T, uuid: 'FD-EST-RECH', estatus_sat: 'rechazado' });
      ok(true, "estatus_sat acepta 'rechazado'");

      // …y sigue rechazando basura (savepoint: no aborta la trx externa)
      let rejected = false;
      try {
        await trx.transaction(async (sp) => { await sp('fiscal.cfdis').insert({ tenant_id: T, uuid: 'FD-EST-BAD', estatus_sat: 'basura' }); });
      } catch { rejected = true; }
      ok(rejected, 'estatus_sat rechaza un valor fuera del dominio (CHECK sigue vivo)');

      // 3. Captura idempotente por (tenant, dedup_key)
      const DK = 'timbrado:test:diag-1';
      const r1 = (await trx.raw(UPSERT, [T, 'timbrado', DK, 'msg-1', 'CFDI40147'])).rows[0];
      ok(r1.es_nuevo === true && Number(r1.attempts) === 1, 'primer fallo → INSERT (attempts=1)');
      const r2 = (await trx.raw(UPSERT, [T, 'timbrado', DK, 'msg-2', '302'])).rows[0];
      ok(r2.es_nuevo === false && Number(r2.attempts) === 2, 'segundo fallo → UPSERT (attempts=2, no duplica)');
      const cnt = (await trx('fiscal.emission_errors').where({ tenant_id: T, dedup_key: DK }).count('* as c'))[0];
      ok(Number(cnt.c) === 1, 'un solo renglón por dedup_key');
      const row = await trx('fiscal.emission_errors').where({ tenant_id: T, dedup_key: DK }).first();
      ok(row.error_message === 'msg-2' && row.pac_code === '302', 'último error sobrescribe (mensaje+código)');

      // 4. Resolución + auto-reapertura al re-fallar
      await trx('fiscal.emission_errors').where({ tenant_id: T, dedup_key: DK }).update({ status: 'resolved', resolved_at: trx.fn.now() });
      const resolved = await trx('fiscal.emission_errors').where({ tenant_id: T, dedup_key: DK }).first();
      ok(resolved.status === 'resolved', 'resolve → status=resolved');
      const r3 = (await trx.raw(UPSERT, [T, 'timbrado', DK, 'msg-3', 'CFDI40102'])).rows[0];
      ok(r3.status === 'open' && Number(r3.attempts) === 3, 're-fallo reabre (status=open, attempts=3)');
      const reopened = await trx('fiscal.emission_errors').where({ tenant_id: T, dedup_key: DK }).first();
      ok(reopened.resolved_at === null, 'resolved_at se limpia al reabrir');

      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error(e); fail++; }
  } finally {
    await knex.destroy();
    console.log(`\n${fail === 0 ? '✅' : '❌'} FD diagnóstico: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
