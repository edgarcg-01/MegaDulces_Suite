/**
 * `[RH.1.7c]` El directorio de todas las plazas («Buscar en todas las plazas») contra Postgres. Lo que se defiende:
 * la MISMA regla que el padrón de cada sitio (manda el código ligado; sin `ignorado`; sólo sitios activos), pero con
 * los códigos sin ligar incluidos, que son justo los que RH busca.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
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
  '20261008094812_hr_agente_corridas',
  '20261008094813_hr_ordenes_quien',
].map((n) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`)));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.1.7c] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el directorio contra la base.');

suite('[RH.1.7c] directorio de todas las plazas contra la base', () => {
  it('un renglón por código y sitio, manda el ligado, sin ignorados ni sitios inactivos', async () => {
    const { HrAttendanceReportService } = await import('./attendance-report.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    let filas: Array<{ site_code: string; codigo: string; nombre: string; ligado: boolean; departamento: string | null; promotora: boolean }> = [];
    try {
      await knex.transaction(async (trx) => {
        for (const m of migs) await m.up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const ctx = { requireTenantId: () => TENANT };
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const report = new HrAttendanceReportService(tk as never, ctx as never);

        const sello = Date.now();
        const A = `dir-a-${sello}`, B = `dir-b-${sello}`, VIEJO = `dir-viejo-${sello}`;
        await trx('hr.attendance_sites').insert([
          { tenant_id: TENANT, code: A, name: 'Plaza A' },
          { tenant_id: TENANT, code: B, name: 'Plaza B' },
          { tenant_id: TENANT, code: VIEJO, name: 'Plaza cerrada', is_active: false },
        ]);
        const reloj = async (serie: string, site: string): Promise<string> => {
          const [d] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: serie, site_code: site }).returning('id');
          return typeof d === 'object' ? d.id : d;
        };
        const a1 = await reloj(`DIR-A1-${sello}`, A), a2 = await reloj(`DIR-A2-${sello}`, A);
        const b1 = await reloj(`DIR-B1-${sello}`, B), v1 = await reloj(`DIR-V1-${sello}`, VIEJO);

        const rol = (await trx('identity.users').first('role_name'))?.role_name ?? 'superadmin';
        await trx('identity.departments').insert({ tenant_id: TENANT, code: `dir_promo_${sello}`, name: 'PROMOTORIA RICOLINO' });
        const [ana] = await trx('identity.users').insert({ tenant_id: TENANT, username: `dir_ana_${sello}`, password_hash: 'x', role_name: rol, nombre: 'PRUEBA LIGADA' }).returning('id');
        const [pro] = await trx('identity.users').insert({ tenant_id: TENANT, username: `dir_pro_${sello}`, password_hash: 'x', role_name: rol, nombre: 'PRUEBA PROMO', department_code: `dir_promo_${sello}` }).returning('id');
        const id = (x: unknown) => (typeof x === 'object' && x ? (x as { id: string }).id : String(x));

        const enr = (device_id: string, device_user_id: string, extra: Record<string, unknown> = {}) =>
          trx('hr.device_enrollments').insert({ tenant_id: TENANT, device_id, device_user_id, device_name: `RELOJ ${device_user_id}`, ...extra });
        // «15» está en los DOS relojes de A: en uno sin ligar (más reciente) y en otro ligado → manda el ligado.
        await enr(a1, '15', { last_seen_at: '2026-10-08T12:00:00Z' });
        await enr(a2, '15', { user_id: id(ana), last_seen_at: '2026-10-01T12:00:00Z' });
        await enr(a1, '22');                                         // sin ligar: sale con el nombre del reloj
        await enr(a1, '99', { match_status: 'ignorado' });           // ⛔ ignorado: no sale
        await enr(b1, '15', { user_id: id(pro) });                   // el mismo número en otra plaza es OTRA persona
        await enr(v1, '40');                                         // ⛔ sitio inactivo: no sale

        filas = (await report.directorio()).filter((f) => [A, B, VIEJO].includes(f.site_code)) as typeof filas;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    const clave = (f: { site_code: string; codigo: string }) => `${f.site_code.split('-')[1]}:${f.codigo}`;
    expect(filas.map(clave).sort()).toEqual(['a:15', 'a:22', 'b:15']);
    const a15 = filas.find((f) => clave(f) === 'a:15');
    expect([a15?.nombre, a15?.ligado]).toEqual(['PRUEBA LIGADA', true]);
    const a22 = filas.find((f) => clave(f) === 'a:22');
    expect([a22?.nombre, a22?.ligado, a22?.departamento]).toEqual(['RELOJ 22', false, null]);
    const b15 = filas.find((f) => clave(f) === 'b:15');
    expect([b15?.nombre, b15?.promotora]).toEqual(['PRUEBA PROMO', true]);
  });
});
