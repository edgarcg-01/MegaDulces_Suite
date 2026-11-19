/**
 * `[RH.17.2]` «Horario distinto» con la salida y la comida del día, contra una base real (regla 13): la captura con
 * el MISMO cuerpo que arma la pantalla (`RhIncidenciasComponent.cuerpoCaptura`), la fila leída de la base, y la
 * asistencia de ese día medida contra el horario capturado.
 *
 * También el orden de despliegue: ANTES de la migración `20261119093204` la asistencia y la lista no se caen, el
 * Horario distinto sin salida se captura igual, y uno con salida se rechaza diciendo por qué (no se pierde en silencio).
 *
 * Todo corre en una transacción que se revierte. Sin `HR_DB_TEST_URL` no corre (NO MEDIDO), y nunca contra prod.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const MIGS = path.resolve(__dirname, '../../../../../database/migrations-newdb');
const previas = [
  '20261007100000_hr_relojes_y_checadas',
  '20261007110000_hr_horarios_y_alertas',
  '20261007304401_hr_incidencias_y_cierres',
  '20261008094812_hr_agente_corridas',
  '20261008094813_hr_ordenes_quien',
  '20261012151620_hr_secciones_por_ficha',
  '20261109110836_hr_person_schedules_varios_horarios',
].map((n) => require(path.join(MIGS, `${n}.js`)));
const salidaYComida = require(path.join(MIGS, '20261119093204_hr_horario_distinto_salida_y_comida.js'));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.17.2] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el Horario distinto con salida contra la base.');

/** Lunes a sábado 08:00–13:00 · 14:00–18:00, del jueves 03 al miércoles 16 de septiembre; `martes` cambia el 15. */
function jornada(martes: string[]): Array<{ codigo: string; fechaHora: string }> {
  const out: Array<{ codigo: string; fechaHora: string }> = [];
  for (let i = 0; i < 14; i++) {
    const f = new Date(Date.parse('2026-09-03T12:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    if (new Date(`${f}T12:00:00Z`).getUTCDay() === 0) continue;
    for (const h of f === '2026-09-15' ? martes : ['08:00', '13:00', '14:00', '18:00']) out.push({ codigo: '15', fechaHora: `${f}T${h}:00` });
  }
  return out;
}

suite('[RH.17.2] Horario distinto con salida y comida, contra la base', () => {
  it('antes y después de la migración, con el cuerpo de la pantalla', async () => {
    const { HrAttendanceIngestService } = await import('./attendance-ingest.service');
    const { HrAttendanceReportService } = await import('./attendance-report.service');
    const { HrAttendanceIncidentsService } = await import('./attendance-incidents.service');
    const { HrAttendanceSchedulesService } = await import('./attendance-schedules.service');
    const reader = await import('./attendance-reader');

    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
      try { await fn(); return 'sin error'; } catch (e) {
        const x = e as { status?: number; getStatus?: () => number; message?: string };
        return `${x.getStatus?.() ?? x.status ?? 'error'} ${x.message ?? ''}`.trim();
      }
    };
    try {
      await knex.transaction(async (trx) => {
        for (const m of previas) await m.up(trx);
        // El «antes»: la base de esta prueba puede traer ya las columnas; se quitan DENTRO de la transacción.
        await salidaYComida.down(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const actor = { tenantId: TENANT, userId: '11111111-0000-0000-0000-00000000000a', username: 'rh_a' };
        const ctx = { get: () => actor, requireTenantId: () => TENANT };
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx), global: trx };
        const ingest = new HrAttendanceIngestService(tk as never);
        const report = new HrAttendanceReportService(tk as never, ctx as never);
        const incidents = new HrAttendanceIncidentsService(tk as never, ctx as never);
        const schedules = new HrAttendanceSchedulesService(tk as never, ctx as never);
        const califica = { puedeCalificar: true, puedeAuditar: false };

        const site = 'rh-hd-dia-prueba';
        const serie = `RH-HD-${Date.now()}`;
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: site, name: 'Prueba horario del día', warehouse_code: '01' });
        const [dev] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: serie, site_code: site }).returning('id');
        const deviceId = typeof dev === 'object' ? dev.id : dev;
        const rol = (await trx('identity.users').first('role_name'))?.role_name ?? 'superadmin';
        const [ana] = await trx('identity.users').insert({ tenant_id: TENANT, username: `ana_hd_${Date.now()}`, password_hash: 'x', role_name: rol, nombre: 'PRUEBA UNO' }).returning('id');
        // El martes 15 trabajó de 08:00 a 14:00 sin comer (RH lo autorizó).
        await ingest.ingest({ serie, usuarios: [{ codigo: '15', nombre: 'Ana R' }], checadas: jornada(['08:00', '14:00']) });
        await trx('hr.device_enrollments').where({ device_id: deviceId, device_user_id: '15' }).update({ user_id: typeof ana === 'object' ? ana.id : ana });
        await schedules.asignar({ site_code: site, person_codes: ['15'], starts_at: '08:00', ends_at: '18:00', lunch_minutes: 60 });

        const sem = { site_code: site, date_from: '2026-09-10', date_to: '2026-09-16' };
        const martes = async () => (await report.asistencia(sem)).personas.find((p) => p.codigo === '15')
          ?.semanas.flatMap((s) => s.dias).find((d) => d.fecha === '2026-09-15');
        // El cuerpo EXACTO que arma la pantalla (`cuerpoCaptura`) para entrada 08:00, salida 14:00, comida 0.
        const cuerpo = {
          site_code: site, person_code: '15', incident_type: 'horario_distinto', date_from: '2026-09-15',
          date_to: undefined, note: undefined, minutes: 480, reason: 'Junta en corporativo',
          authorized_by_name: 'Gerente de prueba', base_schedule_minutes: undefined,
          end_minutes: 840, break_minutes: 0, deliver: undefined,
        };

        // ── ANTES de la migración ──────────────────────────────────────────────────────────
        r['antesHay'] = await reader.tieneHorarioCompleto(trx);
        r['antesLista'] = (await incidents.listar({ site_code: site, date_from: '2026-09-10', date_to: '2026-09-16' })).length;
        r['antesMartes'] = (await martes())?.salidaAntesMin;
        r['antesConSalida'] = await fallo(() => incidents.capturar(cuerpo, califica));
        const soloEntrada = await incidents.capturar({ ...cuerpo, end_minutes: undefined, break_minutes: undefined }, califica);
        r['antesSoloEntrada'] = [soloEntrada.status, soloEntrada.end_minutes, soloEntrada.break_minutes];
        await trx('hr.attendance_incidents').where({ id: soloEntrada.id }).del();

        // ── DESPUÉS de la migración ────────────────────────────────────────────────────────
        await salidaYComida.up(trx);
        await salidaYComida.up(trx);                       // idempotente: la segunda no hace nada
        r['despuesHay'] = await reader.tieneHorarioCompleto(trx);
        const hd = await incidents.capturar(cuerpo, califica);
        const fila = await trx('hr.attendance_incidents').where({ id: hd.id }).first('minutes', 'end_minutes', 'break_minutes', 'note', 'status');
        r['fila'] = [fila?.minutes, fila?.end_minutes, fila?.break_minutes, fila?.note, fila?.status];
        r['respuesta'] = [hd.end_minutes, hd.break_minutes];
        const vig = (await reader.incidenciasEnRango(trx, site, '2026-09-10', '2026-09-16')).find((i) => i.id === hd.id);
        r['vigente'] = [vig?.minutos, vig?.salidaMin, vig?.comidaMin];
        const d = await martes();
        r['martes'] = [d?.salidaAntesMin, d?.esperadoMin, d?.extraMin, d?.salidaEsperada];
        r['malo'] = await fallo(() => incidents.capturar({ ...cuerpo, date_from: '2026-09-16', end_minutes: 420 }, califica));
        r['checkBase'] = await trx.raw('SAVEPOINT ck').then(() =>
          trx('hr.attendance_incidents').where({ id: hd.id }).update({ end_minutes: 1440 }).then(() => 'sin error', (e: { code?: string }) => e.code))
          .finally(() => trx.raw('ROLLBACK TO SAVEPOINT ck'));
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }

    // Antes de la migración: nada se cae, sin salida se captura igual, con salida se rechaza diciendo por qué.
    expect(r['antesHay']).toBe(false);
    expect(r['antesLista']).toBe(0);
    expect(r['antesMartes']).toBe(240);                    // sin Horario distinto: 4 h de salida temprana
    expect(String(r['antesConSalida'])).toMatch(/^400 Todavía no se puede guardar la salida/);
    expect(r['antesSoloEntrada']).toEqual(['calificada', null, null]);
    // Después: se guarda lo que mandó la pantalla, se lee igual, y el martes se mide contra 08:00–14:00.
    expect(r['despuesHay']).toBe(true);
    expect(r['fila']).toEqual([480, 840, 0, 'Junta en corporativo', 'calificada']);
    expect(r['respuesta']).toEqual([840, 0]);
    expect(r['vigente']).toEqual([480, 840, 0]);
    expect(r['martes']).toEqual([0, 360, 0, '14:00']);
    expect(String(r['malo'])).toMatch(/^400 La salida de ese día tiene que ser después de la entrada/);
    expect(r['checkBase']).toBe('23514');                  // la base también rechaza un minuto fuera del día
  }, 120000);
});
