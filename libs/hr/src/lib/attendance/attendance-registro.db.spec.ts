/**
 * `[RH.15.9]` El registro para la autoridad, contra Postgres: las checadas TAL COMO LAS ENTREGÓ EL RELOJ, con su
 * método, su reloj y su desfase, y una huella sha256 que se puede recalcular sobre el archivo.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 */
import 'reflect-metadata';
import path from 'path';
import { createHash } from 'crypto';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const mig = (n: string) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.15.9] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el registro para la autoridad contra la base.');

/** Recalcula la huella como lo haría quien recibe el archivo: las líneas que no son comentario. */
const huellaDe = (csv: string) => createHash('sha256').update(csv.split('\n').filter((l) => l && !l.startsWith('#')).join('\n') + '\n', 'utf8').digest('hex');

describe('[RH.15.9] la huella del CSV (sin base)', () => {
  it('se recalcula igual sobre el archivo, y cambia si se toca una hora', async () => {
    const { csvDelRegistro } = await import('./attendance-registro.service');
    const fila = { fecha: '2026-11-10', hora: '08:00:00', instante: '2026-11-10T14:00:00Z', reloj: 'S1', metodo: 'huella', tipo: 'entrada', origen: 'agente', desfase_s: 12 };
    const { csv, sha256 } = csvDelRegistro({ plaza: 'Prueba', persona: '15', desde: '2026-11-01', hasta: '2026-11-30', generado: 'x' }, [fila]);
    expect(huellaDe(csv)).toBe(sha256);
    expect(csv).toContain(`# sha256 de las líneas de datos: ${sha256}`);
    // PRUEBA NEGATIVA: una hora cambiada a mano ya no da la misma huella.
    expect(huellaDe(csv.replace('08:00:00', '07:00:00'))).not.toBe(sha256);
    // `[RH.15.5x]` El plazo propio es para el PRIMER `import` del servicio, no para la huella:
    // con la suite entera de `libs/hr` en paralelo pasaba de los 5 s por defecto y se ponía roja
    // sola. Corrida sola, termina en segundos.
  }, 60000);
});

suite('[RH.15.9] el registro de una persona, contra la base', () => {
  it('trae lo que checó, con método, reloj y desfase; rechaza periodos de más de 400 días', async () => {
    const { HrAttendanceRegistroService } = await import('./attendance-registro.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of ['20261007100000_hr_relojes_y_checadas', '20261117103955_rh15_1_checadas_inborrables']) await mig(m).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const svc = new HrAttendanceRegistroService(tk as never, { requireTenantId: () => TENANT } as never);
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: 'rh159-prueba', name: 'Prueba RH.15.9' });
        const [dev] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: 'RH159-S1', label: 'Entrada', site_code: 'rh159-prueba' }).returning('id');
        const id = (dev as { id: string }).id ?? dev;
        await trx('hr.attendance_logs').insert([
          { tenant_id: TENANT, device_id: id, device_user_id: '15', punched_at: '2026-11-10T14:00:00Z', punched_local: '2026-11-10 08:00:00', verify_mode: 1, punch_type: 0, source: 'agente', clock_drift_seconds: 42 },
          { tenant_id: TENANT, device_id: id, device_user_id: '15', punched_at: '2026-11-10T23:30:00Z', punched_local: '2026-11-10 17:30:00', verify_mode: 15, punch_type: 1, source: 'agente' },
          { tenant_id: TENANT, device_id: id, device_user_id: '16', punched_at: '2026-11-10T14:05:00Z', punched_local: '2026-11-10 08:05:00', verify_mode: 1, source: 'agente' },
        ]);
        const reg = await svc.registro({ site_code: 'rh159-prueba', person_code: '15', date_from: '2026-11-01', date_to: '2026-11-30' });
        const datos = reg.csv.split('\n').filter((l) => l && !l.startsWith('#'));
        r['filas'] = reg.filas;
        r['lineas'] = datos.slice(1);
        r['huella'] = huellaDe(reg.csv) === reg.sha256;
        try { await svc.registro({ site_code: 'rh159-prueba', person_code: '15', date_from: '2025-01-01', date_to: '2026-11-30' }); r['tope'] = 'pasó'; }
        catch (e) { r['tope'] = (e as { status?: number }).status; }
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['filas']).toBe(2);
    expect(r['lineas']).toEqual([
      '2026-11-10,08:00:00,2026-11-10T14:00:00Z,RH159-S1 · Entrada,huella,entrada,agente,42',
      '2026-11-10,17:30:00,2026-11-10T23:30:00Z,RH159-S1 · Entrada,rostro,salida,agente,',
    ]);
    expect(r['huella']).toBe(true);
    expect(r['tope']).toBe(400);
  }, 60000);
});
