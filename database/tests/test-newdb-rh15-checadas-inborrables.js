#!/usr/bin/env node
'use strict';
/**
 * `[RH.15.1]` Las checadas son evidencia (LFT 132-XXXIV, 804-III/805): no se editan ni se borran sin rastro.
 *
 * Contra una base real, dentro de una transacción que se deshace, con la migración 20261117103955 aplicada
 * ahí mismo si la base no la tiene. Se INTENTA violar cada defensa y se espera el error exacto:
 *   · cambiar la hora, el código o el reloj de una checada → rechazo (check_violation, RH.15.1);
 *   · ligarla a una persona (employee_id / user_id) → sí se puede;
 *   · borrarla sin motivo → rechazo; con `SET LOCAL hr.borrado_checadas` → se borra Y queda copia;
 *   · borrar un reloj con checadas → rechazo (ya no hay cascada);
 *   · `app_runtime` ya no tiene DELETE.
 * PRUEBA NEGATIVA: con el `down` de la migración, el mismo borrado sin motivo PASA (si no pasara, la prueba no
 * estaría midiendo la migración sino otra cosa).
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-rh15-checadas-inborrables');

const T = '00000000-0000-0000-0000-00000000d01c';
const MIG = require('../migrations-newdb/20261117103955_rh15_1_checadas_inborrables.js');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

(async () => {
  const knex = require('knex')(require('../knexfile-newdb.js').development);
  const REVERTIR = new Error('revertir');
  try { await knex.raw('SELECT 1'); } catch (e) { noMedido(`sin base: ${e.message}`); await knex.destroy().catch(() => undefined); return salir(); }
  try {
    await knex.transaction(async (trx) => {
      if (!(await trx.raw(`SELECT to_regclass('hr.attendance_logs') t`)).rows[0].t) { noMedido('la base no tiene hr.attendance_logs'); throw REVERTIR; }
      await MIG.up(trx);

      // Un reloj y una checada de prueba.
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const sitio = (await trx.raw(`SELECT code FROM hr.attendance_sites WHERE tenant_id = ? LIMIT 1`, [T])).rows[0]?.code ?? null;
      const [dev] = await trx('hr.attendance_devices').insert({ tenant_id: T, serial_number: 'RH151-PRUEBA', label: 'Reloj de prueba RH.15.1', ...(sitio ? { site_code: sitio } : {}) }).returning(['id']);
      const fila = { tenant_id: T, device_id: dev.id, device_user_id: '9151', punched_at: '2026-11-10T14:00:00Z', punched_local: '2026-11-10 08:00:00', source: 'agente' };
      await trx('hr.attendance_logs').insert(fila);
      const llave = { tenant_id: T, device_id: dev.id, device_user_id: '9151' };
      const falla = async (fn) => { await trx.raw('SAVEPOINT rh151'); try { await fn(); await trx.raw('RELEASE SAVEPOINT rh151'); return null; } catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT rh151'); return e; } };
      const esRH151 = (e) => !!e && e.code === '23514' && /RH\.15\.1/.test(e.message);

      let e = await falla(() => trx('hr.attendance_logs').where(llave).update({ punched_at: '2026-11-10T13:00:00Z' }));
      ok(esRH151(e), 'cambiar la HORA de una checada: rechazado (check_violation RH.15.1)');
      e = await falla(() => trx('hr.attendance_logs').where(llave).update({ device_user_id: '9999' }));
      ok(esRH151(e), 'cambiar el CÓDIGO de la persona en el reloj: rechazado');
      e = await falla(() => trx('hr.attendance_logs').where(llave).update({ verify_mode: 15 }));
      ok(esRH151(e), 'cambiar el MÉTODO (huella → rostro): rechazado');
      e = await falla(() => trx('hr.attendance_logs').where(llave).update({ user_id: null, employee_id: null }));
      ok(e === null, `ligarla o desligarla de una persona (employee_id, user_id): permitido${e ? ` (${e.message})` : ''}`);

      e = await falla(() => trx('hr.attendance_logs').where(llave).delete());
      ok(esRH151(e), 'borrarla SIN motivo: rechazado');
      e = await falla(async () => { await trx.raw(`SET LOCAL hr.borrado_checadas = 'no'`); await trx('hr.attendance_logs').where(llave).delete(); });
      ok(esRH151(e), 'borrarla con un motivo de menos de 5 letras: rechazado');

      e = await falla(() => trx('hr.attendance_devices').where({ id: dev.id }).delete());
      ok(!!e && ['23503', '23001'].includes(e.code), `borrar el RELOJ con checadas: rechazado por la llave${e ? ` (${e.code}: ${String(e.message).slice(-90)})` : ' — se borró'}`);

      const g = (await trx.raw(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.role_table_grants
        WHERE table_schema = 'hr' AND table_name = 'attendance_logs' AND grantee = 'app_runtime'`)).rows[0].p || '';
      ok(!g.split(',').includes('DELETE') && g.includes('INSERT'), `app_runtime sin DELETE (tiene: ${g})`);

      await trx.raw(`SET LOCAL hr.borrado_checadas = 'prueba RH.15.1: borrado autorizado'`);
      const n = await trx('hr.attendance_logs').where(llave).delete();
      const copia = (await trx.raw(`SELECT fila, motivo FROM hr.attendance_log_deletions WHERE tenant_id = ? AND fila->>'device_user_id' = '9151'`, [T])).rows;
      ok(n === 1 && copia.length === 1 && copia[0].motivo.startsWith('prueba RH.15.1') && copia[0].fila.punched_local.startsWith('2026-11-10T08:00'),
        'con motivo se borra, y queda la copia de la fila con su motivo');
      await trx.raw(`SET LOCAL hr.borrado_checadas = ''`);

      // PRUEBA NEGATIVA: sin la migración, el borrado sin motivo pasa.
      await trx('hr.attendance_logs').insert(fila);
      await MIG.down(trx);
      e = await falla(() => trx('hr.attendance_logs').where(llave).delete());
      ok(e === null, 'PRUEBA NEGATIVA: con el down, el mismo borrado sin motivo SÍ pasa (la prueba mide la migración)');

      throw REVERTIR;
    });
  } catch (e) {
    if (e !== REVERTIR) { fail++; console.log('  ✗ error inesperado:', e && e.message); }
  } finally {
    await knex.destroy().catch(() => undefined);
  }
  salir();
})();
