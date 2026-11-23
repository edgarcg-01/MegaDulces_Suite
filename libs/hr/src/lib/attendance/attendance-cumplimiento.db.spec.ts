/**
 * `[RH.15.0]` `[RH.15.7]` `[RH.15.8]` Cumplimiento de una plaza, contra Postgres. Transacción que se deshace.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 */
import 'reflect-metadata';
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const mig = (n: string) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.15.x] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el cumplimiento de la plaza contra la base.');

describe('[RH.15.8] hasta cuándo se conservan las checadas (sin base)', () => {
  it('la baja + 12 meses', async () => {
    const { conservarHasta } = await import('./attendance-cumplimiento.service');
    expect(conservarHasta('2026-11-17')).toBe('2027-11-17');
  }, 30000);   // el import del servicio, con toda la suite cargada, ya pasó de 5 s
});

suite('[RH.15.x] cumplimiento de una plaza, contra la base', () => {
  it('huella de una baja en el reloj, hasta cuándo conservar y quién no registra', async () => {
    const { HrAttendanceCumplimientoService } = await import('./attendance-cumplimiento.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of ['20261007100000_hr_relojes_y_checadas', '20261012151620_hr_secciones_por_ficha']) await mig(m).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const ctx = { requireTenantId: () => TENANT, get: () => ({ userId: null, username: 'rh_prueba' }) };
        const svc = new HrAttendanceCumplimientoService(tk as never, ctx as never);

        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: 'rh156-prueba', name: 'Prueba RH.15.x' });
        const [dev] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: 'RH156-S1', site_code: 'rh156-prueba' }).returning('id');
        const id = (dev as { id: string }).id ?? dev;
        for (const [codigo, activo] of [['15', true], ['16', true], ['17', false]] as const) {
          await trx('hr.person_site_profiles').insert({ tenant_id: TENANT, site_code: 'rh156-prueba', person_code: codigo, is_active: activo,
            updated_at: activo ? trx.fn.now() : '2026-11-01T18:00:00Z' });
          await trx('hr.device_enrollments').insert({ tenant_id: TENANT, device_id: id, device_user_id: codigo, device_name: `PRUEBA ${codigo}`, is_present: true });
        }
        // 15 checó ayer; 16 no checa desde hace dos semanas.
        await trx('hr.attendance_logs').insert([
          { tenant_id: TENANT, device_id: id, device_user_id: '15', punched_at: '2026-11-16T14:00:00Z', punched_local: '2026-11-16 08:00:00', source: 'agente' },
          { tenant_id: TENANT, device_id: id, device_user_id: '16', punched_at: '2026-11-02T14:00:00Z', punched_local: '2026-11-02 08:00:00', source: 'agente' },
        ]);

        const e1 = await svc.estado({ site_code: 'rh156-prueba', hoy: '2026-11-17' });
        r['huellas'] = e1.huellasDeBajas.map((p) => `${p.codigo}:${p.dias}:${p.pendiente}`);
        r['conservar'] = e1.conservar.map((p) => `${p.codigo}:${p.hasta}`);
        r['sinRegistro'] = e1.sinRegistro.map((p) => `${p.codigo}:${p.ultima}`);


        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['huellas']).toEqual(['17:16:true']);
    expect(r['conservar']).toEqual(['17:2027-11-01']);
    expect(r['sinRegistro']).toEqual(['16:2026-11-02']);
  }, 60000);
});
