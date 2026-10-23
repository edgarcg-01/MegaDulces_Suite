/**
 * `[RH.1.10]` El banco de horas extra contra Postgres: ganadas del cálculo real, ajuste, anulación.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local npx vitest run -c libs/hr/vitest.config.ts horas-extra-banco
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const RAIZ = path.resolve(__dirname, '../../../../..');
const mig = (n: string) => require(path.join(RAIZ, 'database/migrations-newdb', `${n}.js`));
const FASE = [
  '20261007100000_hr_relojes_y_checadas', '20261007110000_hr_horarios_y_alertas', '20261007304401_hr_incidencias_y_cierres',
  '20261008094812_hr_agente_corridas', '20261008094813_hr_ordenes_quien', '20261012122707_hr_horas_extra_ajustes',
  // [RH.1.4b] el lector de asistencia toma la sección y el estado por plaza de aquí.
  '20261012151620_hr_secciones_por_ficha',
  '20261021090942_hr_person_schedules_varios_horarios', // [RH.1.15] el lector selecciona shifts
];

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.1.10] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el banco de horas extra contra la base.');

/** Igual que en los otros `.db.spec` de hr: se reintenta sólo el deadlock entre archivos en paralelo. */
async function conReintento<T>(fn: () => Promise<T>, intentos = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if ((e as { code?: string }).code !== '40P01' || i >= intentos) throw e;
      await new Promise((res) => setTimeout(res, 300 * i));
    }
  }
}

suite('banco de horas extra contra la base', () => {
  it('ganadas del cálculo, ajuste y anulación', async () => {
    const { HrAttendanceReportService } = await import('./attendance-report.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
      try { await fn(); return 'sin error'; } catch (e) {
        const x = e as { getStatus?: () => number; code?: string };
        return String(x.getStatus?.() ?? x.code ?? 'error');
      }
    };
    try {
      await conReintento(() => knex.transaction(async (trx) => {
        const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((x: { name: string }) => x.name.replace(/\.js$/, '')));
        for (const m of FASE) if (!aplicadas.has(m)) await mig(m).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const ctx = { get: () => ({ tenantId: TENANT, userId: null, username: 'rh_prueba' }), requireTenantId: () => TENANT };
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const report = new HrAttendanceReportService(tk as never, ctx as never);
        const ot = report;

        const site = `rh-he-${Date.now()}`;
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: site, name: 'Prueba horas extra', warehouse_code: '01' });
        const [dev] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: `RH-HE-${Date.now()}`, site_code: site }).returning('id');
        const deviceId = typeof dev === 'object' ? dev.id : dev;
        const rol = (await trx('identity.users').first('role_name'))?.role_name ?? 'superadmin';
        const [u] = await trx('identity.users').insert({ tenant_id: TENANT, username: `he_rh_${Date.now()}`, password_hash: 'x', role_name: rol, nombre: 'PRUEBA HORAS EXTRA' }).returning('id');
        await trx('hr.device_enrollments').insert({ tenant_id: TENANT, device_id: deviceId, device_user_id: '21', match_status: 'pendiente', user_id: typeof u === 'object' ? u.id : u });

        // Lunes a sábado 08:00–13:00 · 14:00–18:00 del 14-sep al 03-oct; el viernes 02-oct sale a las 19:10.
        const logs: Array<Record<string, unknown>> = [];
        for (let i = 0; i < 20; i++) {
          const f = new Date(Date.parse('2026-09-14T12:00:00Z') + i * 86400000).toISOString().slice(0, 10);
          if (new Date(`${f}T12:00:00Z`).getUTCDay() === 0) continue;
          for (const h of ['08:00', '13:00', '14:00', f === '2026-10-02' ? '19:10' : '18:00']) {
            logs.push({ tenant_id: TENANT, device_id: deviceId, device_user_id: '21', punched_local: `${f} ${h}:00`, punched_at: `${f}T${h}:00-06:00`, source: 'manual' });
          }
        }
        await trx('hr.attendance_logs').insert(logs);

        const b1 = await ot.bancoHorasExtra({ site_code: site, date_to: '2026-10-03' });
        r['antes'] = b1.personas.map((p) => [p.codigo, p.ganadasMin, p.saldoMin, p.segun]);

        const aj = await ot.crearAjusteHorasExtra({ site_code: site, person_code: '21', minutes: 330, reason: 'saldo que traía al 23 de septiembre', effective_date: '2026-09-24' });
        r['conAjuste'] = (await ot.bancoHorasExtra({ site_code: site, date_to: '2026-10-03', person_code: '21' })).personas.map((p) => [p.ajustesMin, p.saldoMin]);
        r['ajusteSinMotivo'] = await fallo(() => ot.crearAjusteHorasExtra({ site_code: site, person_code: '21', minutes: 30, reason: 'x' }));
        r['ajusteEnCero'] = await fallo(() => ot.crearAjusteHorasExtra({ site_code: site, person_code: '21', minutes: 0, reason: 'corrección de prueba' }));
        // ⛔ NEGATIVA a nivel base: aunque alguien saltara la validación, el CHECK lo frena.
        r['checkEnCero'] = await fallo(() => trx.transaction(async (sp) => {
          await sp('hr.overtime_adjustments').insert({ tenant_id: TENANT, site_code: site, person_code: '21', minutes: 0, reason: 'directo en la base' });
        }));

        r['anularSinMotivo'] = await fallo(() => ot.anularAjusteHorasExtra(aj.id, 'no'));
        await ot.anularAjusteHorasExtra(aj.id, 'se capturó dos veces');
        r['anularOtraVez'] = await fallo(() => ot.anularAjusteHorasExtra(aj.id, 'se capturó dos veces'));
        r['despues'] = (await ot.bancoHorasExtra({ site_code: site, date_to: '2026-10-03', person_code: '21' })).personas.map((p) => [p.ajustesMin, p.saldoMin]);
        r['sigueEnLaTabla'] = (await trx('hr.overtime_adjustments').where({ id: aj.id }).first('void_reason'))?.void_reason;
        throw ROLLBACK;
      }));
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    expect(r['antes']).toEqual([['21', 60, 60, 'deducido']]);
    expect(r['conAjuste']).toEqual([[330, 390]]);
    expect(r['ajusteSinMotivo']).toBe('400');
    expect(r['ajusteEnCero']).toBe('400');
    expect(r['checkEnCero']).toBe('23514');
    expect(r['anularSinMotivo']).toBe('400');
    expect(r['anularOtraVez']).toBe('404');
    expect(r['despues']).toEqual([[0, 60]]);
    expect(r['sigueEnLaTabla']).toBe('se capturó dos veces');
  }, 120_000);
});
