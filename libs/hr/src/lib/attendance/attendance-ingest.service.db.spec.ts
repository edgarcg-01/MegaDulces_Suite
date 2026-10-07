/**
 * `[RH.1.2]` La entrada de checadas contra Postgres de verdad (no un mock).
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local npx vitest run -c libs/hr/vitest.config.ts
 *
 * Aplica las 3 migraciones de `[RH.1.1]` y todo lo que escribe DENTRO de una transacción
 * que se deshace al final: la base queda como estaba. Sin `HR_DB_TEST_URL` se declara NO
 * MEDIDO (se salta, no pasa en verde): en el CI no hay base (ADR-056).
 *
 * ⚠️ Nunca apuntar a producción: la URL debe ser de una base de desarrollo.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const migs = [
  '20261007100000_hr_relojes_y_checadas',
  '20261007110000_hr_horarios_y_alertas',
  '20261007300000_hr_incidencias_y_cierres',
].map((n) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`)));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.1.2] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la entrada contra la base.');

suite('HrAttendanceIngestService contra la base', () => {
  it('aplica, deduplica, convierte la hora, respeta nombres y separa lo que no se aplica', async () => {
    // Import dinámico: el barril de platform-core exige JWT_SECRET al cargarse, y este archivo
    // también se importa en el CI (donde la prueba se salta). Así sólo se carga si corre.
    const { HrAttendanceIngestService } = await import('./attendance-ingest.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const resultados: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of migs) await m.up(trx);
        const tk = {
          run: async (tenant: string, cb: (t: Knex.Transaction) => Promise<unknown>) => {
            await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenant]);
            return cb(trx);
          },
          global: trx,
        };
        const svc = new HrAttendanceIngestService(tk as never);
        const serie = `RH-ING-${Date.now()}`;

        // 1) Serie desconocida: se guarda cruda, no se aplica
        const r0 = await svc.ingest({ serie, checadas: [{ codigo: '15', fechaHora: '2026-10-06T08:00:00' }] });
        resultados['desconocida'] = r0.estado;
        const crudo = await trx('hr.ingest_batches').where({ serial_number: serie }).first();
        resultados['crudoGuardado'] = crudo?.status === 'sin_registrar' && crudo?.raw != null;

        // Alta del sitio y del reloj
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: 'rh-prueba', name: 'Prueba', warehouse_code: '01' });
        const [dev] = await trx('hr.attendance_devices')
          .insert({ tenant_id: TENANT, serial_number: serie, site_code: 'rh-prueba' }).returning('id');
        const deviceId = typeof dev === 'object' ? dev.id : dev;

        // 2) Lote normal con padrón
        const lote = {
          serie, agenteHost: 'prueba', infoReloj: { logCounts: 3, userCounts: 2 },
          usuarios: [{ codigo: '15', nombre: 'Ana' }, { codigo: '16', nombre: '' }],
          checadas: [
            { codigo: '15', fechaHora: '2026-10-06T08:00:00', tipo: 0 },
            { codigo: '16', fechaHora: '2026-10-06T08:05:00', tipo: 0 },
            { codigo: '17', fechaHora: '2026-10-06T08:10:00', tipo: 0 },   // checa sin estar en el padrón
            { codigo: '15', fechaHora: '2000-01-01T00:00:00' },              // basura del reloj sin hora
          ],
        };
        const r1 = await svc.ingest(lote);
        resultados['aplicado'] = [r1.estado, r1.aceptadas, r1.rechazadas];
        // 3) El mismo lote otra vez: idempotente
        const r2 = await svc.ingest(lote);
        resultados['repetido'] = [r2.aceptadas, r2.duplicadas];

        // 4) Hora de pared → instante con la zona del reloj (MX = UTC-6)
        const log = await trx('hr.attendance_logs').where({ device_id: deviceId, device_user_id: '15' }).first();
        resultados['instante'] = new Date(log.punched_at).toISOString();

        // 5) Quien checa existe, y el nombre del reloj sólo rellena
        const enr = await trx('hr.device_enrollments').where({ device_id: deviceId }).orderBy('device_user_id');
        resultados['enrolados'] = enr.map((e: { device_user_id: string; device_name: string }) => `${e.device_user_id}:${e.device_name}`);
        await trx('hr.device_enrollments').where({ device_id: deviceId, device_user_id: '15' }).update({ device_name: 'Ana Corregida' });
        await svc.ingest({ serie, usuarios: [{ codigo: '15', nombre: 'Ana' }], checadas: [] });
        resultados['nombreRespetado'] = (await trx('hr.device_enrollments').where({ device_id: deviceId, device_user_id: '15' }).first()).device_name;

        // 6) Un número ignorado que vuelve a checar después queda para revisión
        await trx('hr.device_enrollments').where({ device_id: deviceId, device_user_id: '16' })
          .update({ match_status: 'ignorado', updated_at: trx.raw(`now() - interval '3 days'`) });
        const r3 = await svc.ingest({ serie, checadas: [{ codigo: '16', fechaHora: new Date().toISOString().slice(0, 19) }] });
        resultados['reaparecido'] = [r3.reaparecidos, (await trx('hr.device_enrollments').where({ device_id: deviceId, device_user_id: '16' }).first()).match_status];

        // 7) Reloj en pausa: el lote se guarda sin aplicar
        await trx('hr.attendance_devices').where({ id: deviceId }).update({ is_paused: true });
        const r4 = await svc.ingest({ serie, checadas: [{ codigo: '15', fechaHora: '2026-10-07T08:00:00' }] });
        resultados['pausa'] = [r4.estado, r4.aceptadas];
        await trx('hr.attendance_devices').where({ id: deviceId }).update({ is_paused: false });

        // 8) Latido: desconocido 409; con error, se guarda el error
        resultados['latidoDesconocido'] = (await svc.heartbeat({ serie: 'NO-EXISTE' })).status;
        await svc.heartbeat({ serie, error: 'no contesta el reloj' });
        resultados['latidoError'] = (await trx('hr.attendance_devices').where({ id: deviceId }).first()).last_error;

        // 9) Padrón para el agente, con las llaves que ya entiende
        const reg = (await svc.registry({ sucursalId: 'rh-prueba' }))[0];
        resultados['padron'] = reg && Object.keys(reg).sort();

        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }

    expect(resultados['desconocida']).toBe('serie_desconocida');
    expect(resultados['crudoGuardado']).toBe(true);
    expect(resultados['aplicado']).toEqual(['aplicado', 3, 1]);
    expect(resultados['repetido']).toEqual([0, 3]);
    expect(resultados['instante']).toBe('2026-10-06T14:00:00.000Z');
    expect(resultados['enrolados']).toEqual(['15:Ana', '16:Empleado 16', '17:Empleado 17']);
    expect(resultados['nombreRespetado']).toBe('Ana Corregida');
    expect(resultados['reaparecido']).toEqual([['16'], 'pendiente']);
    expect(resultados['pausa']).toEqual(['pendiente', 0]);
    expect(resultados['latidoDesconocido']).toBe(409);
    expect(resultados['latidoError']).toBe('no contesta el reloj');
    expect(resultados['padron']).toEqual(['alias', 'commKey', 'ip', 'modo', 'nota', 'pendiente', 'puerto', 'serie', 'sucursalId']);
  }, 60000);
});
