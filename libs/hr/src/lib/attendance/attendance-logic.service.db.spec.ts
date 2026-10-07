/**
 * `[RH.1.5]`/`[RH.1.6]` La lógica de asistencia contra Postgres de verdad, de punta a punta:
 *
 *   lote del reloj → ingesta → `hr.v_site_punches` → asistencia por persona, agente de alertas,
 *   incidencias (con separación de funciones), cierre de semana y reapertura.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 *
 * Aplica las 4 migraciones de la fase y todo lo que escribe DENTRO de una transacción que se
 * deshace al final. Sin `HR_DB_TEST_URL` se declara NO MEDIDO (se salta): en el CI no hay base.
 * ⚠️ Nunca apuntar a producción.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const migs = [
  '20261007100000_hr_relojes_y_checadas',
  '20261007110000_hr_horarios_y_alertas',
  '20261007120000_hr_incidencias_y_cierres',
  '20261007130000_hr_agente_corridas',
].map((n) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`)));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.1.5] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la lógica de asistencia contra la base.');

/** Lunes a sábado 08:00–13:00 · 14:00–18:00 del 03 al 16 de septiembre, con excepciones. */
function jornada(codigo: string, entrada: (f: string) => string | null): Array<{ codigo: string; fechaHora: string }> {
  const out: Array<{ codigo: string; fechaHora: string }> = [];
  for (let i = 0; i < 14; i++) {
    const f = new Date(Date.parse('2026-09-03T12:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    if (new Date(`${f}T12:00:00Z`).getUTCDay() === 0) continue;
    const e = entrada(f);
    if (!e) continue;
    for (const h of [e, '13:00', '14:00', '18:00']) out.push({ codigo, fechaHora: `${f}T${h}:00` });
  }
  return out;
}

suite('lógica de asistencia contra la base', () => {
  it('asistencia, agente, incidencias, cierre y reapertura', async () => {
    const { HrAttendanceIngestService } = await import('./attendance-ingest.service');
    const { HrAttendanceReportService } = await import('./attendance-report.service');
    const { HrAttendanceAgentService } = await import('./attendance-agent.service');
    const { HrAttendanceAlertsService } = await import('./attendance-alerts.service');
    const { HrAttendanceIncidentsService } = await import('./attendance-incidents.service');
    const { HrAttendanceClosuresService } = await import('./attendance-closures.service');
    const { HrAttendanceSchedulesService } = await import('./attendance-schedules.service');

    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
      try { await fn(); return 'sin error'; } catch (e) {
        const x = e as { status?: number; getStatus?: () => number; code?: string };
        return String(x.getStatus?.() ?? x.status ?? x.code ?? 'error');
      }
    };
    try {
      await knex.transaction(async (trx) => {
        for (const m of migs) await m.up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const actor = { tenantId: TENANT, userId: '11111111-0000-0000-0000-00000000000a', username: 'rh_a' };
        const ctx = { get: () => actor, requireTenantId: () => TENANT };
        const tk = {
          run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx),
          global: trx,
        };
        const ingest = new HrAttendanceIngestService(tk as never);
        const report = new HrAttendanceReportService(tk as never, ctx as never);
        const agent = new HrAttendanceAgentService(tk as never, ctx as never);
        const alerts = new HrAttendanceAlertsService(tk as never, ctx as never);
        const incidents = new HrAttendanceIncidentsService(tk as never, ctx as never);
        const closures = new HrAttendanceClosuresService(tk as never, ctx as never, report, incidents);
        const schedules = new HrAttendanceSchedulesService(tk as never, ctx as never);
        const quien = (userId: string, username: string) => { actor.userId = userId; actor.username = username; };
        const A = '11111111-0000-0000-0000-00000000000a';
        const B = '11111111-0000-0000-0000-00000000000b';
        const C = '11111111-0000-0000-0000-00000000000c';
        const califica = { puedeCalificar: true, puedeAuditar: false };
        const captura = { puedeCalificar: false, puedeAuditar: false };
        const audita = { puedeCalificar: false, puedeAuditar: true };

        // ── Sitio, reloj y personas ─────────────────────────────────────────────────────────
        const site = 'rh-logica-prueba';
        const serie = `RH-LOG-${Date.now()}`;
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: site, name: 'Prueba lógica', warehouse_code: '01' });
        const [dev] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: serie, site_code: site }).returning('id');
        const deviceId = typeof dev === 'object' ? dev.id : dev;
        const rol = (await trx('identity.users').first('role_name'))?.role_name ?? 'superadmin';
        await trx('identity.departments').insert({ tenant_id: TENANT, code: 'promotoria_rh_prueba', name: 'Promotoría (prueba)' });
        const [ana] = await trx('identity.users').insert({ tenant_id: TENANT, username: `ana_rh_${Date.now()}`, password_hash: 'x', role_name: rol, nombre: 'PRUEBA UNO' }).returning('id');
        const [pro] = await trx('identity.users').insert({ tenant_id: TENANT, username: `pro_rh_${Date.now()}`, password_hash: 'x', role_name: rol, nombre: 'PRUEBA PROMOTORA', department_code: 'promotoria_rh_prueba' }).returning('id');

        // Ana: falta el martes 15 y llega 08:40 el lunes 14. «17» (sin ligar) entra 09:00; el jueves
        // 10 se le leyó dos veces la entrada y sólo marcó la salida a comer (tres marcas: impar).
        // La promotora checa dos días.
        const checadas = [
          ...jornada('15', (f) => (f === '2026-09-15' ? null : f === '2026-09-14' ? '08:40' : '08:00')),
          ...jornada('17', () => '09:00').filter((c) => c.fechaHora !== '2026-09-10T18:00:00' && c.fechaHora !== '2026-09-10T14:00:00'),
          { codigo: '17', fechaHora: '2026-09-10T09:02:00' },
          ...jornada('16', (f) => (f === '2026-09-11' || f === '2026-09-12' ? '10:00' : null)),
        ];
        const lote = await ingest.ingest({ serie, usuarios: [{ codigo: '15', nombre: 'Ana R' }, { codigo: '17', nombre: 'Juan' }], checadas });
        r['ingesta'] = [lote.estado, lote.aceptadas];
        await trx('hr.device_enrollments').where({ device_id: deviceId, device_user_id: '15' }).update({ user_id: typeof ana === 'object' ? ana.id : ana });
        await trx('hr.device_enrollments').where({ device_id: deviceId, device_user_id: '16' }).update({ user_id: typeof pro === 'object' ? pro.id : pro });

        // ── Asistencia por persona (semana del jueves 10 al miércoles 16) ───────────────────
        const sem = { site_code: site, date_from: '2026-09-10', date_to: '2026-09-16' };
        const a1 = await report.asistencia(sem);
        const ana1 = a1.personas.find((p) => p.codigo === '15');
        r['ana'] = [ana1?.horario, ana1?.faltas, ana1?.retardoRealMin, ana1?.registrado, ana1?.nombre];
        r['juan'] = [a1.personas.find((p) => p.codigo === '17')?.horario, a1.personas.find((p) => p.codigo === '17')?.registrado];
        r['promotoraFueraDePlanta'] = a1.personas.some((p) => p.codigo === '16');
        r['promotoraEnSuVista'] = (await report.asistencia({ ...sem, only_promoters: true })).personas.map((p) => p.codigo);

        // Horario asignado por RH: Juan es 09:30, así que entrar 09:00 nunca es retardo.
        await schedules.asignar({ site_code: site, person_codes: ['17'], starts_at: '09:30', ends_at: '18:00', lunch_minutes: 60 });
        r['juanAsignado'] = (await report.asistencia(sem)).personas.find((p) => p.codigo === '17')?.horarioAsignado?.entrada;
        r['horarioMalo'] = await fallo(() => schedules.asignar({ site_code: site, person_codes: ['17'], starts_at: '18:00', ends_at: '09:00', lunch_minutes: 60 }));

        // ── Agente de alertas ───────────────────────────────────────────────────────────────
        const an1 = await agent.analizar({ siteCode: site, desde: '2026-09-10', hasta: '2026-09-16' });
        const claves = (await alerts.listar({ site_code: site }) as Array<{ person_code: string; work_date: string; rule: string }>)
          .map((x) => `${x.person_code}|${x.work_date}|${x.rule}`).sort();
        r['alertas'] = claves;
        r['primera'] = [an1.borradores.creadas, an1.borradores.actualizadas];
        const an2 = await agent.analizar({ siteCode: site, desde: '2026-09-10', hasta: '2026-09-16' });
        r['segunda'] = [an2.borradores.creadas, an2.borradores.actualizadas];
        const dup = (await alerts.listar({ site_code: site }) as Array<{ id: string; rule: string }>).find((x) => x.rule === 'checada_duplicada');
        await alerts.decidir(String(dup?.id), 'descartada', 'el lector lee doble');
        const an3 = await agent.analizar({ siteCode: site, desde: '2026-09-10', hasta: '2026-09-16' });
        r['decididaNoSePisa'] = [an3.borradores.sinCambio, (await trx('hr.attendance_alerts').where({ id: dup?.id }).first('status'))?.status];
        r['grupoAprobar'] = await fallo(() => alerts.decidirGrupo({ rule: 'entrada_sin_salida', site_code: site, status: 'aprobada' }));

        // El agente solo: deja su corrida por sitio; la segunda pasada, sin cambios, se salta.
        const p1 = await agent.pasada(TENANT, { siteCode: site, forzar: true });
        const p2 = await agent.pasada(TENANT, { siteCode: site });
        r['pasadas'] = [p1.sitios[0]?.saltada, p2.sitios[0]?.saltada, p1.latido];
        r['corrida'] = (await trx('hr.attendance_agent_runs').where({ site_code: site }).first('fingerprint'))?.fingerprint;

        // ── Incidencias ─────────────────────────────────────────────────────────────────────
        quien(A, 'rh_a');
        const vac = await incidents.capturar({ site_code: site, person_code: '15', incident_type: 'vacaciones', date_from: '2026-09-15', note: 'folio 9' }, califica);
        r['vacaciones'] = [vac.status, vac.banderas];
        const a2 = (await report.asistencia(sem)).personas.find((p) => p.codigo === '15');
        r['anaConVacaciones'] = [a2?.faltas, a2?.faltasJustificadas];

        quien(B, 'rh_b');
        const per = await incidents.capturar({ site_code: site, person_code: '15', incident_type: 'permiso_con_goce', date_from: '2026-09-14', note: 'cita' }, captura);
        r['permisoCapturado'] = [per.status, (await report.asistencia(sem)).personas.find((p) => p.codigo === '15')?.retardoRealMin];
        r['cerrarConPendiente'] = await fallo(() => closures.cerrar({ site_code: site, period_start: '2026-09-10' }));
        r['bCalifica'] = await fallo(() => incidents.paso(per.id, 'calificar', '', captura));

        quien(A, 'rh_a');
        await incidents.paso(per.id, 'calificar', '', califica);
        r['permisoCalificado'] = (await report.asistencia(sem)).personas.find((p) => p.codigo === '15')?.retardoRealMin;

        r['cerrarMiercoles'] = await fallo(() => closures.cerrar({ site_code: site, period_start: '2026-09-09' }));
        const cierre = await closures.cerrar({ site_code: site, period_start: '2026-09-10' }) as { id: string; period_end: string; vigente: boolean };
        r['cierre'] = [cierre.period_end, cierre.vigente];
        r['estadosCerrados'] = (await trx('hr.attendance_incidents').where({ site_code: site }).orderBy('date_from').select('status')).map((x: { status: string }) => x.status);
        r['capturarEnCerrada'] = await fallo(() => incidents.capturar({ site_code: site, person_code: '17', incident_type: 'vacaciones', date_from: '2026-09-11', note: 'x' }, califica));
        r['cerrarOtraVez'] = await fallo(() => closures.cerrar({ site_code: site, period_start: '2026-09-10' }));
        const foto = await closures.uno(cierre.id) as { snapshot: { personas: Array<{ codigo: string; faltas: number }> } };
        r['foto'] = foto.snapshot.personas.find((p) => p.codigo === '15')?.faltas;

        // Separación de funciones: quien calificó no audita; otra persona sí.
        r['aAudita'] = await fallo(() => incidents.paso(per.id, 'auditar', '', { puedeCalificar: true, puedeAuditar: true }));
        quien(C, 'rh_c');
        r['cAudita'] = (await incidents.paso(per.id, 'auditar', 'ok', audita)).status;
        // …y la base lo sostiene aunque el código se equivoque: auditar con el id de quien capturó.
        await trx.raw('SAVEPOINT sod');
        r['checkSoD'] = await fallo(() => trx('hr.attendance_incidents').where({ id: per.id }).update({ audited_by: B }));
        await trx.raw('ROLLBACK TO SAVEPOINT sod');

        // La bitácora es de sólo agregar para la app.
        await trx.raw('SAVEPOINT bit');
        await trx.raw('SET LOCAL ROLE app_runtime');
        r['bitacoraEditable'] = await fallo(() => trx('hr.attendance_incident_log').where({ incident_id: per.id }).update({ detail: 'x' }));
        await trx.raw('ROLLBACK TO SAVEPOINT bit');
        r['pasosBitacora'] = (await incidents.bitacora(per.id) as Array<{ action: string }>).map((x) => x.action);

        // ── Reabrir ─────────────────────────────────────────────────────────────────────────
        r['reabrirSinMotivo'] = await fallo(() => closures.reabrir(cierre.id, ' '));
        await closures.reabrir(cierre.id, 'faltó una incapacidad');
        r['estadosReabiertos'] = (await trx('hr.attendance_incidents').where({ site_code: site }).orderBy('date_from').select('status')).map((x: { status: string }) => x.status);
        r['capturarReabierta'] = (await incidents.capturar({ site_code: site, person_code: '17', incident_type: 'incapacidad', date_from: '2026-09-11', note: 'imss' }, califica)).status;

        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }

    expect(r['ingesta']).toEqual(['aplicado', expect.any(Number)]);
    expect(r['ana']).toEqual(['08:00', 1, 25, true, 'PRUEBA UNO']);
    expect(r['juan']).toEqual(['09:00', false]);
    expect(r['promotoraFueraDePlanta']).toBe(false);
    expect(r['promotoraEnSuVista']).toEqual(['16']);
    expect(r['juanAsignado']).toBe('09:30');
    expect(r['horarioMalo']).toBe('400');

    // Sin horarios de sitio no hay retardo ni falta que el detector pueda medir (Mega Talento igual):
    // quedan la doble lectura y la entrada sin salida del jueves 10 de Juan.
    expect(r['alertas']).toEqual(['17|2026-09-10|checada_duplicada', '17|2026-09-10|entrada_sin_salida']);
    expect(r['primera']).toEqual([2, 0]);
    expect(r['segunda']).toEqual([0, 2]);
    expect(r['decididaNoSePisa']).toEqual([1, 'descartada']);
    expect(r['grupoAprobar']).toBe('400');
    expect(r['pasadas']).toEqual([false, true, false]);
    expect(String(r['corrida'])).toMatch(/^2026-09-16\|\d+$/);

    // Capturada hoy por algo de septiembre: además de autocalificada, es retroactiva (> 7 días).
    expect(r['vacaciones']).toEqual(['calificada', ['autocalificada', 'retroactiva']]);
    expect(r['anaConVacaciones']).toEqual([0, 1]);
    expect(r['permisoCapturado']).toEqual(['capturada', 25]);
    expect(r['cerrarConPendiente']).toBe('409');
    expect(r['bCalifica']).toBe('403');
    expect(r['permisoCalificado']).toBe(0);
    expect(r['cerrarMiercoles']).toBe('400');
    expect(r['cierre']).toEqual(['2026-09-16', true]);
    expect(r['estadosCerrados']).toEqual(['cerrada', 'cerrada']);
    expect(r['capturarEnCerrada']).toBe('409');
    expect(r['cerrarOtraVez']).toBe('409');
    expect(r['foto']).toBe(0);
    expect(r['aAudita']).toBe('409');
    expect(r['cAudita']).toBe('auditada');
    expect(r['checkSoD']).toBe('23514');
    expect(r['bitacoraEditable']).toBe('42501');
    expect(r['pasosBitacora']).toEqual(['creada', 'calificada', 'cerrada', 'auditada']);
    expect(r['reabrirSinMotivo']).toBe('400');
    expect(r['estadosReabiertos']).toEqual(['calificada', 'calificada']);
    expect(r['capturarReabierta']).toBe('calificada');
  }, 120000);
});
