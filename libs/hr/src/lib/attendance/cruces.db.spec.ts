/**
 * `[RH.7.4]` Cruces de plaza contra Postgres: la persona enrolada en dos plazas se encuentra por su `user_id` (no por
 * nombre), sus checadas salen de `hr.v_site_punches` con el día LOCAL, un código `ignorado` no cruza, y quien sólo está
 * en una plaza no aparece.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts cruces
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.7.4] NO MEDIDO: sin HR_DB_TEST_URL no se prueban los cruces de plaza contra la base.');

suite('[RH.7.4] cruces de plaza, contra la base', () => {
  it('por user_id, con el día local; sin ignorados ni gente de una sola plaza', async () => {
    const { HrAttendanceReportService } = await import('./attendance-report.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    let r: Awaited<ReturnType<InstanceType<typeof HrAttendanceReportService>['cruces']>> | null = null;
    try {
      await knex.transaction(async (trx) => {
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const tk = { run: async (_t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const svc = new HrAttendanceReportService(tk as never, { requireTenantId: () => TENANT, get: () => null } as never);
        // Lo que la base ya traiga: la prueba mide lo que SUMAN sus personas.
        const antes = (await svc.cruces({ date_from: '2026-11-02', date_to: '2026-11-03' })).enDosSedes;
        const sello = String(Date.now()).slice(-7);
        const P1 = `rh74a-${sello}`, P2 = `rh74b-${sello}`;
        for (const [code, name] of [[P1, 'Plaza A'], [P2, 'Plaza B']]) {
          await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code, name, warehouse_code: '03' });
        }
        const reloj = async (site: string) => String((await trx('hr.attendance_devices')
          .insert({ tenant_id: TENANT, serial_number: `RH74${site}`, site_code: site, timezone: 'America/Mexico_City' }).returning('id'))[0].id);
        const A = await reloj(P1);
        const B = await reloj(P2);
        const usuario = async (nombre: string) => String((await trx('identity.users').insert({
          tenant_id: TENANT, username: `rh74.${nombre.split(' ')[0].toLowerCase()}.${sello}`, password_hash: 'x', nombre,
          role_name: 'sin_acceso', kind: 'interno', status: 'invited', warehouse_code: '03',
        }).returning('id'))[0].id);
        const ROTA = await usuario('Rota Dos Plazas Prueba');
        const FIJA = await usuario('Fija Una Plaza Prueba');
        const enr = async (dev: string, code: string, user: string, o: Record<string, unknown> = {}) =>
          trx('hr.device_enrollments').insert({ tenant_id: TENANT, device_id: dev, device_user_id: code, user_id: user, match_status: 'confirmado', ...o });
        await enr(A, '7', ROTA);
        await enr(B, '21', ROTA);         // otro código en la otra plaza: la misma persona
        await enr(A, '8', FIJA);
        await enr(B, '99', FIJA, { match_status: 'ignorado' });   // ⛔ ignorado: no la vuelve multiplaza
        // Hora LOCAL de México; `punched_at` en UTC (+6 h). El martes 3: jornada en A que se pisa con una en B.
        const marca = async (dev: string, code: string, local: string) => {
          const utc = new Date(`${local}:00-06:00`);
          await trx('hr.attendance_logs').insert({ tenant_id: TENANT, device_id: dev, device_user_id: code, punched_at: utc, punched_local: local.replace('T', ' ') });
        };
        for (const h of ['07:00', '15:00']) await marca(A, '7', `2026-11-03T${h}`);
        for (const h of ['09:00', '13:00']) await marca(B, '21', `2026-11-03T${h}`);
        // 23:30 local del 4 = 05:30 UTC del 5: cuenta en el día 4, fuera del rango (el rango acaba el 3).
        await marca(B, '21', '2026-11-04T23:30');
        // …y ese día 4 también checa en A: si el rango se colara un día, saldría un cruce más.
        for (const h of ['10:00', '18:00']) await marca(A, '7', `2026-11-04T${h}`);
        // ⛔ Un código IGNORADO de la misma persona en B: sus checadas del lunes 2 no deben formar un cruce con A.
        await enr(B, '55', ROTA, { match_status: 'ignorado' });
        for (const h of ['08:00', '12:00']) await marca(B, '55', `2026-11-02T${h}`);
        for (const h of ['09:00', '17:00']) await marca(A, '7', `2026-11-02T${h}`);
        for (const h of ['08:00', '16:00']) { await marca(A, '8', `2026-11-03T${h}`); await marca(B, '99', `2026-11-03T${h}`); }

        const t0 = Date.now();
        r = await svc.cruces({ date_from: '2026-11-02', date_to: '2026-11-03' });
        (r as unknown as { ms: number }).ms = Date.now() - t0;
        // ⛔ Sólo ROTA suma: FIJA tiene un código en la otra plaza, pero está `ignorado`.
        (r as unknown as { suman: number }).suman = r.enDosSedes - antes;
        const mia = r.personas.filter((p) => p.user_id === ROTA || p.user_id === FIJA);
        (r as unknown as { mias: unknown }).mias = mia.map((p) => [p.user_id === ROTA, p.clase, p.dias.map((d) => d.fecha),
          p.dias[0]?.estancias.map((x) => `${x.site_code === P1 ? 'A' : 'B'}#${x.codigo} ${x.primera}-${x.ultima}`).sort(),
          p.altas.length]);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    const x = r as unknown as { mias: unknown[]; ms: number; suman: number };
    expect(x.mias).toEqual([[true, 'traslape', ['2026-11-03'], ['A#7 07:00-15:00', 'B#21 09:00-13:00'], 2]]);
    expect(x.suman).toBe(1);
    expect(x.ms).toBeLessThan(500);
  }, 60_000);
});
