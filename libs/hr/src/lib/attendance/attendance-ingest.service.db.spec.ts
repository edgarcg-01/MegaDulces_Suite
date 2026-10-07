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
  '20261007304401_hr_incidencias_y_cierres',
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

  /**
   * `[RH.1.8]` El puente con el histórico: un lector sin marca de agua reenvía el buffer completo del
   * reloj, y lo que la carga dejó en el reloj DESCONOCIDO del sitio no se vuelve a meter.
   * Cada caso tiene su gemelo que SÍ entra: si el puente se pasara de largo, se vería aquí.
   */
  it('no vuelve a meter lo que ya está en el reloj desconocido del sitio (y sólo eso)', async () => {
    const { HrAttendanceIngestService } = await import('./attendance-ingest.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of migs) await m.up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx), global: trx };
        const svc = new HrAttendanceIngestService(tk as never);
        const id = (x: unknown) => (typeof x === 'object' && x ? (x as { id: string }).id : (x as string));
        const sufijo = Date.now();
        const [sitio, otro] = [`rh-puente-${sufijo}`, `rh-otro-${sufijo}`];
        await trx('hr.attendance_sites').insert([
          { tenant_id: TENANT, code: sitio, name: 'Puente' }, { tenant_id: TENANT, code: otro, name: 'Otro' }]);
        const serie = `RH-PUENTE-${sufijo}`;
        const [real] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: serie, site_code: sitio }).returning('id');
        const [desc] = await trx('hr.attendance_devices').insert({
          tenant_id: TENANT, serial_number: `MT-SIN-RELOJ-${sitio}`, site_code: sitio, is_active: false, is_paused: true, ingest_mode: 'manual' }).returning('id');
        const [descOtro] = await trx('hr.attendance_devices').insert({
          tenant_id: TENANT, serial_number: `MT-SIN-RELOJ-${otro}`, site_code: otro, is_active: false, is_paused: true, ingest_mode: 'manual' }).returning('id');
        // Un reloj que traduce: su usuario crudo «R9» es la persona «9» del sitio (como el de comida de corporativo).
        await trx('hr.device_enrollments').insert({ tenant_id: TENANT, device_id: id(real), device_user_id: 'R9', person_code: '9', device_name: 'Nueve' });
        // El histórico que dejó la carga (sin reloj): en el desconocido, con el código del SITIO.
        const hist = (dev: unknown, u: string, l: string) => ({
          tenant_id: TENANT, device_id: id(dev), device_user_id: u, punched_local: l,
          punched_at: trx.raw(`(?::timestamp AT TIME ZONE 'America/Mexico_City')`, [l]), source: 'carga_unica' });
        await trx('hr.attendance_logs').insert([
          hist(desc, '15', '2026-06-01T08:00:07'),
          hist(desc, '9', '2026-06-01T09:00:00'),
          hist(descOtro, '16', '2026-06-01T08:00:07'),   // otro sitio: no cuenta
        ]);

        // El lector reenvía el buffer completo con la serie del reloj real.
        const res = await svc.ingest({ serie, checadas: [
          { codigo: '15', fechaHora: '2026-06-01T08:00:07' },  // ya está en el desconocido → NO entra
          { codigo: '15', fechaHora: '2026-06-01T08:00:08' },  // otro segundo → entra
          { codigo: 'R9', fechaHora: '2026-06-01T09:00:00' },  // crudo que traduce a «9», ya está → NO entra
          { codigo: '16', fechaHora: '2026-06-01T08:00:07' },  // la gemela es de OTRO sitio → entra
          { codigo: '20', fechaHora: '2026-06-01T08:30:00' },  // nueva → entra
        ] });
        r['res'] = [res.estado, res.aceptadas, res.duplicadas];
        const enReal = await trx('hr.attendance_logs').where({ device_id: id(real) }).orderBy(['device_user_id', 'punched_local'])
          .select('device_user_id', trx.raw(`to_char(punched_local, 'HH24:MI:SS') AS h`));
        r['enReal'] = enReal.map((x: { device_user_id: string; h: string }) => `${x.device_user_id}@${x.h}`);
        // El histórico no se tocó.
        r['desconocido'] = Number((await trx('hr.attendance_logs').where({ device_id: id(desc) }).count('* as n').first())?.['n']);
        // Sin reloj desconocido en el sitio (instalación nueva), todo entra.
        await trx('hr.attendance_logs').where({ device_id: id(desc) }).delete();
        await trx('hr.attendance_devices').where({ id: id(desc) }).delete();
        const res2 = await svc.ingest({ serie, checadas: [{ codigo: '15', fechaHora: '2026-06-01T08:00:07' }] });
        r['sinDesconocido'] = res2.aceptadas;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['res']).toEqual(['aplicado', 3, 2]);
    expect(r['enReal']).toEqual(['15@08:00:08', '16@08:00:07', '20@08:30:00']);
    expect(r['desconocido']).toBe(2);
    expect(r['sinDesconocido']).toBe(1);
  }, 60000);
});
