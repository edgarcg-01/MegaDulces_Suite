/* eslint-disable no-console */
/**
 * `[PRV.2]` Mesa de Servicio — la BASE del consentimiento del aviso de privacidad. Smoke DB-direct con ROLLBACK: cero efecto real.
 *
 *   1. Esquema: las 2 tablas con RLS forzado, `queues.privacy_notice_code`, los 2 triggers; TI y Mantenimiento NO exigen aviso.
 *   2. CHECKs del aviso: código, versión, estado, textos, URL, y «vigente exige fecha de publicación».
 *   3. Una sola versión VIGENTE por código (índice único parcial) y la misma versión no se repite.
 *   4. El TEXTO de un aviso publicado no se edita; un borrador sí. El estado sólo avanza (y retirado no vuelve).
 *   5. Aceptaciones: una por (versión, persona); no se modifican (trigger); el aviso aceptado no se borra (FK).
 *   6. Lo mismo ACTUANDO COMO `app_runtime`: sin UPDATE ni DELETE sobre las aceptaciones, sin DELETE sobre los avisos, y aislamiento por tenant.
 *
 * ⚠️ «Un gate sin prueba negativa es una intención» (ADR-056): cada defensa se rompe a propósito UNA vez, exigiendo el SQLSTATE exacto, y cada
 * negativa trae su CONTROL POSITIVO (la misma operación permitida SÍ pasa): sin él, un rechazo podría venir de una consulta rota.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-privacidad-consentimiento');

const T = '00000000-0000-0000-0000-00000000d01c';
const T2 = '00000000-0000-0000-0000-00000000d02c';

let pass = 0;
let fail = 0;
const ok = (cond, msg, det) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg, det ?? ''); } };

async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_prv');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || e.message; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_prv');
  return code;
}

(async () => {
  try {
    console.log('\n1 — esquema y lo de siempre');
    const tablas = (await knex.raw(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname='servicedesk' AND c.relname IN ('privacy_notices','privacy_acceptances') ORDER BY 1`)).rows;
    ok(tablas.length === 2 && tablas.every((t) => t.relrowsecurity && t.relforcerowsecurity), 'las 2 tablas existen con RLS habilitado y FORZADO', JSON.stringify(tablas));
    const col = (await knex.raw(`SELECT 1 FROM information_schema.columns WHERE table_schema='servicedesk' AND table_name='queues' AND column_name='privacy_notice_code'`)).rows;
    ok(col.length === 1, 'queues.privacy_notice_code existe');
    const trg = (await knex.raw(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname='servicedesk' AND NOT t.tgisinternal AND t.tgname IN ('trg_privacy_notices_protege','trg_privacy_acceptances_inmutable') ORDER BY 1`)).rows.map((r) => r.tgname);
    ok(JSON.stringify(trg) === JSON.stringify(['trg_privacy_acceptances_inmutable', 'trg_privacy_notices_protege']), 'los 2 triggers existen', JSON.stringify(trg));
    const exigen = await knex('servicedesk.queues').where({ tenant_id: T }).whereNotNull('privacy_notice_code').count({ n: '*' }).first();
    ok(Number(exigen.n) === 0, '⭐ ninguna cola exige aviso todavía (TI y Mantenimiento quedan EXACTAMENTE como estaban)');

    const usuario = await knex('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
    const usuario2 = await knex('identity.users').where({ tenant_id: T }).whereNull('deleted_at').whereNot('id', usuario?.id ?? '00000000-0000-0000-0000-000000000000').first('id');
    if (!usuario || !usuario2) {
      console.log('  ⚠️  NO MEDIDO: hacen falta dos usuarios con qué probar las aceptaciones');
      fail++;
      return;
    }
    const tenant2 = await knex('identity.tenants').where({ id: T2 }).first('id');

    await knex.transaction(async (trx) => {
      let n = 0;
      const aviso = async (o = {}) => (await trx('servicedesk.privacy_notices').insert({
        tenant_id: T, code: `smoke_prv${Date.now() % 100000}`, version: 1, status: 'borrador', title: 'Aviso de privacidad — Recursos Humanos',
        summary_text: 'Usaremos los datos que escribas para atender tu solicitud y cumplir obligaciones laborales.', consent_text: 'He leído el aviso y consiento el tratamiento de mis datos.', ...o,
      }).returning('*'))[0];
      const aceptar = (notice_id, user_id = usuario.id, extra = {}) => trx('servicedesk.privacy_acceptances').insert({ tenant_id: T, notice_id, user_id, ...extra }).returning('*');

      console.log('\n2 — CHECKs del aviso');
      const cod = `smoke_ck${Date.now() % 100000}`;
      ok((await codigo(trx, () => aviso({ code: 'RH Empleados' }))) === '23514', '⛔ código mal formado → CHECK');
      ok((await codigo(trx, () => aviso({ code: cod, version: 0 }))) === '23514', '⛔ versión 0 → CHECK');
      ok((await codigo(trx, () => aviso({ code: cod, status: 'publicado' }))) === '23514', '⛔ estado desconocido → CHECK');
      ok((await codigo(trx, () => aviso({ code: cod, summary_text: 'corto' }))) === '23514', '⛔ un resumen de 5 caracteres no es un aviso → CHECK');
      ok((await codigo(trx, () => aviso({ code: cod, consent_text: 'sí' }))) === '23514', '⛔ una casilla sin texto → CHECK');
      ok((await codigo(trx, () => aviso({ code: cod, full_url: 'javascript:alert(1)' }))) === '23514', '⛔ una URL que no es http(s) → CHECK');
      ok((await codigo(trx, () => aviso({ code: cod }))) === null, 'CONTROL: un aviso válido (borrador) SÍ entra');
      const v = await aviso({ code: `smoke_pub${Date.now() % 100000}`, status: 'vigente' });
      ok(v.published_at !== null, '⭐ un aviso que nace vigente recibe su fecha de publicación (no queda «vigente» sin fecha)');

      console.log('\n3 — una sola vigente por código');
      const c3 = `smoke_vg${Date.now() % 100000}`;
      const v1 = await aviso({ code: c3, version: 1, status: 'vigente' });
      ok((await codigo(trx, () => aviso({ code: c3, version: 2, status: 'vigente' }))) === '23505', '⛔ una SEGUNDA versión vigente del mismo código → único parcial');
      ok((await codigo(trx, () => aviso({ code: c3, version: 1, status: 'borrador' }))) === '23505', '⛔ la misma versión dos veces → único');
      ok((await codigo(trx, () => aviso({ code: c3, version: 2, status: 'borrador' }))) === null, 'CONTROL: un BORRADOR de la versión 2 sí puede coexistir con la vigente');
      ok((await codigo(trx, () => aviso({ code: `smoke_otro${Date.now() % 100000}`, version: 1, status: 'vigente' }))) === null, 'CONTROL: otro código puede tener su propia vigente');

      console.log('\n4 — el texto publicado no se edita; el estado sólo avanza');
      const dos = await aviso({ code: c3, version: 3, status: 'borrador' });
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: dos.id }).update({ summary_text: 'Texto corregido del borrador para la versión tres.' }))) === null, 'CONTROL: un BORRADOR sí se edita');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: v1.id }).update({ summary_text: 'Otro texto distinto para una versión que ya es vigente.' }))) === '23514', '⭐ el resumen de un aviso VIGENTE no se edita');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: v1.id }).update({ consent_text: 'Texto de casilla distinto para el aviso vigente.' }))) === '23514', '⭐ ni el texto de la casilla');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: v1.id }).update({ full_url: 'https://ejemplo.mx/otro' }))) === '23514', '⭐ ni la URL del aviso integral');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: v1.id }).update({ version: 9 }))) === '23514', 'ni su versión');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: v1.id }).update({ status: 'borrador' }))) === '23514', '⛔ un aviso vigente NO vuelve a borrador');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: v1.id }).update({ updated_at: trx.fn.now() }))) === null, 'CONTROL: tocar campos que no son texto sí se puede');
      await trx('servicedesk.privacy_notices').where({ id: v1.id }).update({ status: 'retirado' });
      const ret = await trx('servicedesk.privacy_notices').where({ id: v1.id }).first('status', 'retired_at');
      ok(ret.status === 'retirado' && ret.retired_at !== null, '⭐ retirar un aviso vigente funciona y deja su fecha de retiro');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: v1.id }).update({ status: 'vigente' }))) === '23514', '⛔ un aviso RETIRADO no vuelve a ser vigente (se publica uno nuevo)');

      console.log('\n5 — aceptaciones');
      const vig = await aviso({ code: `smoke_ac${Date.now() % 100000}`, status: 'vigente' });
      const [a1] = await aceptar(vig.id);
      ok(a1.accepted_at !== null, '⭐ aceptar guarda quién, qué versión y cuándo');
      ok((await codigo(trx, () => aceptar(vig.id))) === '23505', '⛔ la misma persona no acepta dos veces la MISMA versión (una fila por versión y persona)');
      ok((await codigo(trx, () => aceptar(vig.id, usuario2.id))) === null, 'CONTROL: otra persona sí acepta la misma versión');
      ok((await codigo(trx, () => aceptar('00000000-0000-4000-8000-0000000000aa'))) === '23503', '⛔ aceptar un aviso que no existe → FK');
      ok((await codigo(trx, () => aceptar(vig.id, '00000000-0000-4000-8000-0000000000bb'))) === '23503', '⛔ aceptar a nombre de una persona que no existe → FK');
      ok((await codigo(trx, () => trx('servicedesk.privacy_acceptances').where({ id: a1.id }).update({ accepted_at: new Date('2020-01-01') }))) === '23514', '⭐ la FECHA de una aceptación no se reescribe (ni siquiera con privilegios)');
      ok((await codigo(trx, () => trx('servicedesk.privacy_acceptances').where({ id: a1.id }).update({ user_id: usuario2.id }))) === '23514', '⭐ ni a quién pertenece');
      const cDel = await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: vig.id }).del());
      ok(cDel === '23001', '⛔ un aviso que ya tiene aceptaciones no se borra (ON DELETE RESTRICT)', cDel);

      console.log('\n6 — lo mismo actuando como app_runtime (los permisos y el RLS reales)');
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const rv = (await trx('servicedesk.privacy_notices').insert({ tenant_id: T, code: `smoke_rt${Date.now() % 100000}`, version: 1, status: 'vigente', title: 'rt', summary_text: 'Resumen del aviso para la prueba del runtime.', consent_text: 'Acepto el aviso de prueba.' }).returning('id'))[0].id;
      const [ra] = await trx('servicedesk.privacy_acceptances').insert({ tenant_id: T, notice_id: rv, user_id: usuario.id }).returning('id');
      ok(!!ra.id, '⭐ el runtime SÍ puede publicar un aviso y registrar una aceptación (lo que hará el servicio)');
      ok((await codigo(trx, () => trx('servicedesk.privacy_acceptances').where({ id: ra.id }).update({ accepted_at: trx.fn.now() }))) === '42501', '⭐ el runtime NO puede modificar una aceptación (sin permiso de UPDATE)');
      ok((await codigo(trx, () => trx('servicedesk.privacy_acceptances').where({ id: ra.id }).del())) === '42501', '⭐ ni borrarla (sin permiso de DELETE)');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: rv }).del())) === '42501', '⭐ ni borrar un aviso');
      ok((await codigo(trx, () => trx('servicedesk.privacy_notices').where({ id: rv }).update({ summary_text: 'Otro resumen distinto para el aviso del runtime.' }))) === '23514', 'y el trigger del texto también lo frena actuando como runtime');
      if (tenant2) {
        const ajeno = await trx('servicedesk.privacy_notices').where({ tenant_id: T2 }).count({ n: '*' }).first();
        ok(Number(ajeno.n) === 0, '⭐ el runtime del tenant 1 NO ve avisos de otro tenant (RLS)');
        ok((await codigo(trx, () => trx('servicedesk.privacy_notices').insert({ tenant_id: T2, code: 'smoke_x', version: 1, title: 'x', summary_text: 'Resumen de un aviso de otro tenant.', consent_text: 'Acepto el aviso ajeno.' }))) === '42501', '⛔ ni escribir en el de otro tenant (WITH CHECK)');
      } else {
        console.log('  ⚠️  NO MEDIDO: no hay un segundo tenant con qué probar el aislamiento');
      }
      await trx.raw('RESET ROLE');
      n += 0;
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
  } catch (e) {
    fail++;
    console.log('\n  ✗ EXCEPCIÓN:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
