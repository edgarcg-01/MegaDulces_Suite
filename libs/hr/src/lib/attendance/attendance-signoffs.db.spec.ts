/**
 * `[RH.15.5]` La firma de la semana, contra Postgres (regla 13: el endpoint que escribe, ejercido con el payload de la
 * pantalla). Todo dentro de una transacción que se deshace; el bucket se simula (sólo guarda la llave).
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 *
 * Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import 'reflect-metadata';
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const mig = (n: string) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`));
const MIGS = ['20261007100000_hr_relojes_y_checadas', '20261007110000_hr_horarios_y_alertas', '20261007304401_hr_incidencias_y_cierres',
  '20261117105402_rh15_5_firmas_de_la_semana'];
/** Un PNG de 1×1: lo que manda la pantalla al subir una foto de la hoja. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.15.5] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la firma de la semana contra la base.');

/** La foto de un cierre con tres personas en dos departamentos (y un código sin identificar, que no firma). */
const foto = (horasAna = 48) => ({
  personas: [
    { codigo: '15', nombre: 'Ana', nombreCompleto: 'PRUEBA UNO', departamento: 'ALMACEN', registrado: true, horasTrabajadas: horasAna },
    { codigo: '16', nombre: 'Beto', nombreCompleto: 'PRUEBA DOS', departamento: 'ALMACEN', registrado: true },
    { codigo: '17', nombre: 'Caro', nombreCompleto: 'PRUEBA TRES', departamento: 'CAJAS', registrado: true },
    { codigo: '99', nombre: 'Empleado 99', departamento: null, registrado: false },
  ],
});

suite('[RH.15.5] la firma de la semana, contra la base', () => {
  it('registra la hoja de un departamento, cuenta quién firmó, y una semana reabierta pide volver a firmar', async () => {
    const { HrAttendanceSignoffsService } = await import('./attendance-signoffs.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of MIGS) await mig(m).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx), global: trx };
        const ctx = { requireTenantId: () => TENANT, get: () => ({ userId: null, username: 'rh_prueba' }) };
        const guardados: string[] = [];
        const storage = {
          isConfigured: () => true,
          putBuffer: async (_b: Buffer, _ct: string, folder: string) => { const key = `${folder}/hoja-${guardados.length}.png`; guardados.push(key); return { key }; },
          signedUrl: async (k: string) => `https://bucket.prueba/${k}`,
        };
        const svc = new HrAttendanceSignoffsService(tk as never, ctx as never, storage as never);
        const falla = async (fn: () => Promise<unknown>) => { await trx.raw('SAVEPOINT f'); try { await fn(); await trx.raw('RELEASE SAVEPOINT f'); return null; } catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT f'); return e as { status?: number; message: string }; } };

        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: 'rh155-prueba', name: 'Prueba RH.15.5' });
        const semana = { site_code: 'rh155-prueba', period_start: '2026-11-05' };
        const pantalla = { ...semana, department: 'ALMACEN', person_codes: ['15', '16'], jefe_nombre: 'JEFE DE PRUEBA', file_data_uri: PNG, file_name: 'hoja almacen.png' };

        // Sin cierre no se firma.
        r['sinCierre'] = (await falla(() => svc.registrar(pantalla)))?.status;

        const [c1] = await trx('hr.attendance_closures').insert({ tenant_id: TENANT, ...semana, period_end: '2026-11-11', snapshot: JSON.stringify(foto()) }).returning('id');
        const e0 = await svc.estado(semana);
        r['antes'] = [e0.cerrada, e0.firmaron, e0.total, e0.departamentos.map((d) => `${d.department}:${d.total}`).join(',')];

        // Una persona que no es del departamento, o un archivo que no es imagen ni PDF: rechazo, nada se guarda.
        r['ajena'] = (await falla(() => svc.registrar({ ...pantalla, person_codes: ['15', '17'] })))?.status;
        r['archivoMalo'] = (await falla(() => svc.registrar({ ...pantalla, file_data_uri: 'data:text/plain;base64,aG9sYQ==' })))?.status;
        r['sinJefe'] = (await falla(() => svc.registrar({ ...pantalla, jefe_nombre: ' ' })))?.status;

        // La hoja de la pantalla.
        const h = await svc.registrar(pantalla);
        const e1 = await svc.estado(semana);
        r['hoja'] = [h.vigente, h.file_type, h.person_codes.join(','), guardados.length];
        r['despues'] = [e1.firmaron, e1.total, e1.departamentos.find((d) => d.department === 'ALMACEN')?.firmaron];
        r['url'] = (await svc.archivo(h.id)).url.startsWith('https://bucket.prueba/hr/');

        // Se reabre y se vuelve a cerrar DISTINTA: la hoja vieja ya no vale, hay que volver a firmar.
        await trx('hr.attendance_closures').where({ id: (c1 as { id: string }).id ?? c1 })
          .update({ reopened_at: trx.fn.now(), reopen_reason: 'prueba: faltaba una incidencia' });
        await trx('hr.attendance_closures').insert({ tenant_id: TENANT, ...semana, period_end: '2026-11-11', snapshot: JSON.stringify(foto(50)) });
        const e2 = await svc.estado(semana);
        r['reabierta'] = [e2.firmaron, e2.hojas[0]?.vigente];

        // Anular pide motivo; anulada no cuenta y no se borra.
        r['anularSinMotivo'] = (await falla(() => svc.anular(h.id, 'no')))?.status;
        await svc.anular(h.id, 'prueba: hoja de otra semana');
        const fila = await trx('hr.attendance_signoffs').where({ id: h.id }).first('void_reason');
        r['anulada'] = fila?.void_reason;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['sinCierre']).toBe(409);
    expect(r['antes']).toEqual([true, 0, 3, 'ALMACEN:2,CAJAS:1']);
    expect([r['ajena'], r['archivoMalo'], r['sinJefe']]).toEqual([400, 400, 400]);
    expect(r['hoja']).toEqual([true, 'image/png', '15,16', 1]);
    expect(r['despues']).toEqual([2, 3, 2]);
    expect(r['url']).toBe(true);
    expect(r['reabierta']).toEqual([0, false]);
    expect(r['anularSinMotivo']).toBe(400);
    expect(r['anulada']).toBe('prueba: hoja de otra semana');
  }, 60000);
});

describe('[RH.15.5] el controlador nuevo arranca (design:paramtypes, por #414)', () => {
  it('Nest le inyecta el servicio de firmas', async () => {
    const { HrAttendanceSignoffsController } = await import('./attendance-signoffs.controller');
    const { HrAttendanceSignoffsService } = await import('./attendance-signoffs.service');
    expect(Reflect.getMetadata('design:paramtypes', HrAttendanceSignoffsController)).toEqual([HrAttendanceSignoffsService]);
  });
});
