#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[RH.1.1]` Capa de datos de asistencia — candado de las 3 migraciones de la Fase RH.
 *
 *   node database/tests/test-newdb-hr-asistencia-datos.js
 *
 * Corre TODO dentro de una transacción y la deshace al final: la base queda como estaba.
 * Prueba, sobre la base de verdad (no un mock):
 *   1. Las 3 migraciones aplican y se pueden repetir (idempotencia).
 *   2. Cada tabla nueva tiene RLS forzado y la política `tenant_isolation`.
 *   3. La bitácora de incidencias es de sólo agregar para `app_runtime`.
 *   4. Cada regla de negocio puesta como CHECK RECHAZA el caso malo y ACEPTA el bueno
 *      (un candado sin prueba negativa es una intención).
 *   5. Como `app_runtime`, un tenant no ve ni puede escribir filas de otro.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, '../../.env') });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-hr-asistencia-datos');

const knexLib = require('knex');

const MIGS = [
  '20261007100000_hr_relojes_y_checadas',
  '20261007110000_hr_horarios_y_alertas',
  '20261007300000_hr_incidencias_y_cierres',
].map((n) => require(path.resolve(__dirname, '../migrations-newdb', `${n}.js`)));

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000ff';
const ROLLBACK = new Error('rollback-intencional');

let ok = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { ok += 1; console.log(`  ✓ ${msg}`); } else { fail += 1; console.log(`  ✗ ${msg}`); }
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  const knex = knexLib({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  console.log(`\n[RH.1.1] Capa de datos de asistencia — ${url.replace(/\/\/[^@]*@/, '//***@')}`);

  try {
    await knex.transaction(async (trx) => {
      const expectFail = async (label, sql, bindings, code = '23514') => {
        await trx.raw('SAVEPOINT sp');
        try {
          await trx.raw(sql, bindings);
          check(false, `${label} — debía rechazarse y entró`);
        } catch (e) {
          check(e.code === code, `${label} → rechazado (${e.code}${e.code !== code ? ', esperaba ' + code : ''})`);
        }
        await trx.raw('ROLLBACK TO SAVEPOINT sp');
      };
      const expectOk = async (label, sql, bindings) => {
        await trx.raw('SAVEPOINT sp');
        try {
          const r = await trx.raw(sql, bindings);
          check(true, `${label} → aceptado`);
          await trx.raw('RELEASE SAVEPOINT sp');
          return r;
        } catch (e) {
          check(false, `${label} — debía entrar: ${e.code} ${e.message}`);
          await trx.raw('ROLLBACK TO SAVEPOINT sp');
          return null;
        }
      };

      console.log('\n[1] Aplicar y repetir las 3 migraciones');
      for (const m of MIGS) await m.up(trx);
      check(true, 'primera pasada');
      for (const m of MIGS) await m.up(trx);
      check(true, 'segunda pasada (idempotente)');

      console.log('\n[2] Tablas nuevas con RLS forzado');
      const nuevas = ['attendance_sites', 'device_commands', 'ingest_batches', 'work_schedules', 'person_schedules', 'attendance_rules',
        'attendance_alerts', 'attendance_reviews', 'attendance_incidents', 'attendance_incident_log', 'attendance_closures'];
      const { rows: rlsRows } = await trx.raw(`
        SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
               EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'hr' AND p.tablename = c.relname
                        AND p.policyname = 'tenant_isolation') AS policy
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'hr' AND c.relname = ANY(?)`, [nuevas]);
      check(rlsRows.length === nuevas.length, `existen las ${nuevas.length} tablas nuevas (hay ${rlsRows.length})`);
      const sinRls = rlsRows.filter((r) => !(r.rls && r.forced && r.policy)).map((r) => r.relname);
      check(sinRls.length === 0, `todas con RLS forzado y política${sinRls.length ? ' — faltan: ' + sinRls.join(', ') : ''}`);

      const { rows: cols } = await trx.raw(`
        SELECT table_name || '.' || column_name AS c FROM information_schema.columns
         WHERE table_schema = 'hr' AND (table_name, column_name) IN
           (('attendance_devices','ingest_mode'),('attendance_devices','is_paused'),('device_enrollments','user_id'),('device_enrollments','person_code'),
            ('attendance_logs','user_id'),('attendance_logs','source'))`);
      check(cols.length === 6, `columnas nuevas en las tablas de la Fase CH (hay ${cols.length} de 6)`);

      console.log('\n[3] Permisos de app_runtime');
      const priv = async (table, p) => (await trx.raw(`SELECT has_table_privilege('app_runtime', ?, ?) AS ok`, [`hr.${table}`, p])).rows[0].ok;
      check(await priv('attendance_incident_log', 'INSERT'), 'la bitácora acepta INSERT');
      check(!(await priv('attendance_incident_log', 'UPDATE')), 'la bitácora NO acepta UPDATE (prueba negativa)');
      check(!(await priv('attendance_incident_log', 'DELETE')), 'la bitácora NO acepta DELETE (prueba negativa)');
      check(await priv('attendance_incidents', 'UPDATE'), 'las incidencias sí aceptan UPDATE');

      console.log('\n[4] Reglas de negocio: el caso malo se rechaza, el bueno entra');
      const dev = await trx.raw(`INSERT INTO hr.attendance_devices (tenant_id, serial_number) VALUES (?, ?) RETURNING id`,
        [TENANT, `RH-TEST-${Date.now()}`]);
      const deviceId = dev.rows[0].id;

      // Sitios de checado: todo lo de RH cuelga de uno
      await expectFail('sitio con mayúsculas y espacios',
        `INSERT INTO hr.attendance_sites (tenant_id, code, name) VALUES (?, 'Padre Hidalgo', 'Padre Hidalgo')`, [TENANT]);
      await expectOk('sitio de checado 01',
        `INSERT INTO hr.attendance_sites (tenant_id, code, name, warehouse_code) VALUES (?, '01', 'Padre Hidalgo', '01')`, [TENANT]);
      await expectFail('incidencia en un sitio que no existe',
        `INSERT INTO hr.attendance_incidents (tenant_id, site_code, person_code, incident_type, date_from, date_to) VALUES (?, 'no-existe', '15', 'VAC', '2026-10-01', '2026-10-02')`, [TENANT], '23503');
      await expectFail('reloj nuevo en un sitio que no existe',
        `INSERT INTO hr.attendance_devices (tenant_id, serial_number, site_code) VALUES (?, 'RH-TEST-X', 'no-existe')`, [TENANT], '23503');

      // Cierre semanal
      await expectFail('cierre que empieza en lunes',
        `INSERT INTO hr.attendance_closures (tenant_id, site_code, period_start, period_end, snapshot) VALUES (?, '01', '2026-10-05', '2026-10-11', '{}')`, [TENANT]);
      await expectFail('cierre de jueves con 7 días en lugar de 6',
        `INSERT INTO hr.attendance_closures (tenant_id, site_code, period_start, period_end, snapshot) VALUES (?, '01', '2026-10-01', '2026-10-08', '{}')`, [TENANT]);
      await expectOk('cierre jueves 1-oct a miércoles 7-oct',
        `INSERT INTO hr.attendance_closures (tenant_id, site_code, period_start, period_end, snapshot) VALUES (?, '01', '2026-10-01', '2026-10-07', '{}')`, [TENANT]);
      await expectFail('segundo cierre vigente de la misma semana',
        `INSERT INTO hr.attendance_closures (tenant_id, site_code, period_start, period_end, snapshot) VALUES (?, '01', '2026-10-01', '2026-10-07', '{}')`, [TENANT], '23505');
      await expectFail('reabrir sin motivo',
        `UPDATE hr.attendance_closures SET reopened_at = now() WHERE tenant_id = ? AND site_code = '01'`, [TENANT]);
      await expectOk('reabrir con motivo',
        `UPDATE hr.attendance_closures SET reopened_at = now(), reopen_reason = 'faltó una incapacidad' WHERE tenant_id = ? AND site_code = '01'`, [TENANT]);
      await expectOk('volver a cerrar la semana reabierta',
        `INSERT INTO hr.attendance_closures (tenant_id, site_code, period_start, period_end, snapshot) VALUES (?, '01', '2026-10-01', '2026-10-07', '{}')`, [TENANT]);

      // Incidencias
      const u1 = '11111111-1111-1111-1111-111111111111';
      const u2 = '22222222-2222-2222-2222-222222222222';
      await expectFail('incidencia que termina antes de empezar',
        `INSERT INTO hr.attendance_incidents (tenant_id, site_code, person_code, incident_type, date_from, date_to) VALUES (?, '01', '15', 'VAC', '2026-10-05', '2026-10-01')`, [TENANT]);
      await expectFail('auditada por quien la capturó',
        `INSERT INTO hr.attendance_incidents (tenant_id, site_code, person_code, incident_type, date_from, date_to, status, created_by, audited_by, audited_at)
         VALUES (?, '01', '15', 'VAC', '2026-10-01', '2026-10-02', 'auditada', ?, ?, now())`, [TENANT, u1, u1]);
      await expectFail('auditada por quien la calificó',
        `INSERT INTO hr.attendance_incidents (tenant_id, site_code, person_code, incident_type, date_from, date_to, status, created_by, rated_by, audited_by, audited_at)
         VALUES (?, '01', '15', 'VAC', '2026-10-01', '2026-10-02', 'auditada', ?, ?, ?, now())`, [TENANT, u1, u2, u2]);
      await expectFail('anulada sin fecha de anulación',
        `INSERT INTO hr.attendance_incidents (tenant_id, site_code, person_code, incident_type, date_from, date_to, status) VALUES (?, '01', '15', 'VAC', '2026-10-01', '2026-10-02', 'anulada')`, [TENANT]);
      await expectFail('rechazada sin motivo',
        `INSERT INTO hr.attendance_incidents (tenant_id, site_code, person_code, incident_type, date_from, date_to, status) VALUES (?, '01', '15', 'VAC', '2026-10-01', '2026-10-02', 'rechazada')`, [TENANT]);
      await expectFail('estado que no existe',
        `INSERT INTO hr.attendance_incidents (tenant_id, site_code, person_code, incident_type, date_from, date_to, status) VALUES (?, '01', '15', 'VAC', '2026-10-01', '2026-10-02', 'aprobada')`, [TENANT]);
      const inc = await expectOk('incidencia capturada, calificada y auditada por personas distintas',
        `INSERT INTO hr.attendance_incidents (tenant_id, site_code, person_code, incident_type, date_from, date_to, status, created_by, rated_by, rated_at, audited_by, audited_at)
         VALUES (?, '01', '15', 'VAC', '2026-10-01', '2026-10-02', 'auditada', ?, ?, now(), '33333333-3333-3333-3333-333333333333', now()) RETURNING id`, [TENANT, u1, u2]);
      if (inc) {
        await expectOk('bitácora de la incidencia',
          `INSERT INTO hr.attendance_incident_log (tenant_id, incident_id, action, status_before, status_after) VALUES (?, ?, 'auditada', 'cerrada', 'auditada')`,
          [TENANT, inc.rows[0].id]);
      }

      // Horario confirmado
      await expectFail('horario confirmado sin entradas ni horario de sitio',
        `INSERT INTO hr.person_schedules (tenant_id, site_code, person_code) VALUES (?, '01', '15')`, [TENANT]);
      await expectFail('rotativo con 4 entradas',
        `INSERT INTO hr.person_schedules (tenant_id, site_code, person_code, shift_starts) VALUES (?, '01', '16', '{07:00,11:00,15:00,19:00}')`, [TENANT]);
      await expectFail('sábado con horario sin trabajar sábado',
        `INSERT INTO hr.person_schedules (tenant_id, site_code, person_code, shift_starts, saturday_starts_at) VALUES (?, '01', '17', '{09:30}', '09:00')`, [TENANT]);
      await expectOk('rotativo de 2 entradas',
        `INSERT INTO hr.person_schedules (tenant_id, site_code, person_code, shift_starts) VALUES (?, '01', '18', '{07:00,15:00}')`, [TENANT]);

      // Horario de sitio y alertas
      await expectFail('horario con día 7',
        `INSERT INTO hr.work_schedules (tenant_id, site_code, name, weekdays, starts_at, ends_at) VALUES (?, '01', 'Mañana', '{1,7}', '08:00', '16:00')`, [TENANT]);
      await expectFail('horario con inicio de comida pero sin fin',
        `INSERT INTO hr.work_schedules (tenant_id, site_code, name, weekdays, starts_at, lunch_starts_at, ends_at) VALUES (?, '01', 'Mañana', '{1,2}', '08:00', '13:00', '16:00')`, [TENANT]);
      await expectFail('alerta decidida sin fecha de decisión',
        `INSERT INTO hr.attendance_alerts (tenant_id, site_code, person_code, work_date, rule, status) VALUES (?, '01', '15', '2026-10-01', 'retardo', 'aprobada')`, [TENANT]);
      await expectOk('alerta sugerida',
        `INSERT INTO hr.attendance_alerts (tenant_id, site_code, person_code, work_date, rule) VALUES (?, '01', '15', '2026-10-01', 'retardo')`, [TENANT]);
      await expectFail('la misma alerta dos veces',
        `INSERT INTO hr.attendance_alerts (tenant_id, site_code, person_code, work_date, rule) VALUES (?, '01', '15', '2026-10-01', 'retardo')`, [TENANT], '23505');
      await expectFail('dos reglas globales',
        `INSERT INTO hr.attendance_rules (tenant_id, config) VALUES (?, '{}'), (?, '{}')`, [TENANT, TENANT], '23505');

      // Relojes: órdenes, lotes y checadas
      await expectFail('orden al reloj hecha sin fecha de término',
        `INSERT INTO hr.device_commands (tenant_id, device_id, device_user_id, command, status) VALUES (?, ?, '15', 'borrar', 'hecho')`, [TENANT, deviceId]);
      await expectFail('orden con 4 intentos',
        `INSERT INTO hr.device_commands (tenant_id, device_id, device_user_id, command, attempts) VALUES (?, ?, '15', 'borrar', 4)`, [TENANT, deviceId]);
      await expectOk('orden pendiente',
        `INSERT INTO hr.device_commands (tenant_id, device_id, device_user_id, command, payload) VALUES (?, ?, '15', 'renombrar', '{"nombre":"Ana"}')`, [TENANT, deviceId]);
      await expectFail('lote con más aceptadas que registros',
        `INSERT INTO hr.ingest_batches (tenant_id, serial_number, source, records, accepted, status, raw) VALUES (?, 'X', 'agente', 2, 3, 'aplicado', '[]')`, [TENANT]);
      await expectFail('lote sin aplicar y sin el crudo para reprocesar',
        `INSERT INTO hr.ingest_batches (tenant_id, serial_number, source, records, status) VALUES (?, 'X', 'agente', 2, 'sin_registrar')`, [TENANT]);
      await expectOk('lote aplicado sin guardar el crudo',
        `INSERT INTO hr.ingest_batches (tenant_id, serial_number, source, records, accepted, status) VALUES (?, 'X', 'agente', 2, 2, 'aplicado')`, [TENANT]);
      await expectFail('checada con origen que no existe',
        `INSERT INTO hr.attendance_logs (tenant_id, device_id, device_user_id, punched_at, punched_local, source) VALUES (?, ?, '15', now(), now(), 'excel')`, [TENANT, deviceId]);
      await expectOk('checada de carga única',
        `INSERT INTO hr.attendance_logs (tenant_id, device_id, device_user_id, punched_at, punched_local, source) VALUES (?, ?, '15', now(), now(), 'carga_unica')`, [TENANT, deviceId]);

      // Vista por sitio: el código del reloj se traduce al código de la persona en el sitio
      await trx.raw(`UPDATE hr.attendance_devices SET site_code = '01' WHERE id = ?`, [deviceId]);
      await trx.raw(`INSERT INTO hr.device_enrollments (tenant_id, device_id, device_user_id, person_code, device_name) VALUES (?, ?, '15', '115', 'Ana')`, [TENANT, deviceId]);
      const vp = (await trx.raw(`SELECT site_code, person_code, person_name, work_date FROM hr.v_site_punches WHERE tenant_id = ? AND serial_number LIKE 'RH-TEST-%'`, [TENANT])).rows;
      check(vp.length === 1 && vp[0].site_code === '01' && vp[0].person_code === '115' && vp[0].person_name === 'Ana',
        `la vista por sitio traduce el código del reloj (15) al de la persona en el sitio (${vp[0] ? vp[0].person_code : 'nada'})`);
      await trx.raw(`UPDATE hr.device_enrollments SET match_status = 'ignorado' WHERE device_id = ? AND device_user_id = '15'`, [deviceId]);
      const vi = (await trx.raw(`SELECT count(*)::int AS n FROM hr.v_site_punches WHERE serial_number LIKE 'RH-TEST-%'`)).rows[0].n;
      check(vi === 0, `un enrolamiento ignorado no aparece en la vista (aparecen ${vi})`);

      console.log('\n[5] Aislamiento por empresa como app_runtime');
      await trx.raw(`SET LOCAL ROLE app_runtime`);
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO]);
      const visto = (await trx.raw(`SELECT count(*)::int AS n FROM hr.attendance_alerts`)).rows[0].n;
      check(visto === 0, `otra empresa ve 0 alertas de Mega Dulces (ve ${visto})`);
      await expectFail('otra empresa escribe una fila con el tenant de Mega Dulces',
        `INSERT INTO hr.work_schedules (tenant_id, site_code, name, starts_at, ends_at) VALUES (?, '01', 'X', '08:00', '16:00')`, [TENANT], '42501');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
      const propio = (await trx.raw(`SELECT count(*)::int AS n FROM hr.attendance_alerts`)).rows[0].n;
      check(propio >= 1, `Mega Dulces ve su alerta (ve ${propio})`);
      await expectFail('app_runtime intenta editar la bitácora',
        `UPDATE hr.attendance_incident_log SET detail = 'x'`, [], '42501');
      await trx.raw(`RESET ROLE`);

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { fail += 1; console.log(`  ✗ error inesperado: ${e.code || ''} ${e.message}`); }
  } finally {
    await knex.destroy();
  }

  console.log(`\nResultado: ${ok} ✓ · ${fail} ✗  (todo se deshizo: la base quedó como estaba)`);
  process.exit(fail ? 1 : 0);
})();
