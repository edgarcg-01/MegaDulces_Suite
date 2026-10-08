/**
 * `[RH.1.2]` Administrar los relojes contra Postgres: alta, semáforo, lotes guardados y su
 * reproceso, y el ciclo completo de una orden (RH la pide → el agente la recoge → reporta).
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
if (!URL) console.warn('[RH.1.2] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la administración de relojes contra la base.');

suite('administración de relojes contra la base', () => {
  it('alta, semáforo, reproceso y el ciclo de una orden', async () => {
    const { HrAttendanceIngestService } = await import('./attendance-ingest.service');
    const { HrAttendanceDevicesService } = await import('./attendance-devices.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
      try { await fn(); return 'sin error'; } catch (e) {
        const x = e as { getStatus?: () => number; code?: string };
        return String(x.getStatus?.() ?? x.code ?? 'error');
      }
    };
    try {
      await knex.transaction(async (trx) => {
        for (const m of migs) await m.up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const ctx = { get: () => ({ tenantId: TENANT, userId: '11111111-0000-0000-0000-00000000000a', username: 'rh_a' }), requireTenantId: () => TENANT };
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx), global: trx };
        const ingest = new HrAttendanceIngestService(tk as never);
        const devices = new HrAttendanceDevicesService(tk as never, ctx as never, ingest);
        const site = 'rh-relojes-prueba';
        const sello = Date.now();
        const A = `RH-DEV-A-${sello}`, B = `RH-DEV-B-${sello}`;
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: site, name: 'Prueba relojes', warehouse_code: '00' });

        // ── Un lote de un reloj que todavía no existe: se guarda, no se pierde ─────────────
        const l0 = await ingest.ingest({ serie: B, checadas: [{ codigo: '7', fechaHora: '2026-10-01T08:00:00' }, { codigo: '7', fechaHora: '2026-10-01T18:00:00' }] });
        r['sinRegistrar'] = l0.estado;
        r['pendientes'] = (await devices.lotesPendientes() as Array<{ serial_number: string; registros: number }>)
          .filter((x) => x.serial_number === B).map((x) => x.registros);

        // ── Alta de los dos relojes; el reloj desconocido de la carga no se puede dar de alta ──
        await devices.guardar(A, { site_code: site, label: 'Entrada', ip_address: '10.0.0.1' });
        await devices.guardar(B, { site_code: site, label: 'Comida', ip_address: '10.0.0.2' });
        r['altaMala'] = [
          await fallo(() => devices.guardar(`MT-SIN-RELOJ-${site}`, { site_code: site })),
          await fallo(() => devices.guardar('X1', { site_code: 'no-existe' })),
          await fallo(() => devices.guardar('X2', { site_code: site, port: 70000 })),
        ];
        r['listado'] = (await devices.listar() as Array<{ serial_number: string }>).filter((d) => [A, B].includes(d.serial_number)).length;

        // ── Reproceso: el lote guardado se aplica ahora que el reloj existe ───────────────
        const rep = await devices.reprocesar(B);
        r['reproceso'] = [rep.lotes, rep.aplicados, rep.aceptadas];
        const lote = await trx('hr.ingest_batches').where({ serial_number: B }).first('status', 'raw', 'reprocessed_at');
        r['loteReprocesado'] = [lote.status, lote.raw, !!lote.reprocessed_at];
        r['repetirReproceso'] = (await devices.reprocesar(B)).lotes;

        // ── Semáforo: A no ha dado señal (mudo); B tampoco (el reproceso no es señal de vida) ──
        await ingest.heartbeat({ serie: A });
        const estado = await devices.estado() as Array<{ serie: string; semaforo: string }>;
        r['semaforo'] = [estado.find((e) => e.serie === A)?.semaforo, estado.find((e) => e.serie === B)?.semaforo];

        // ── Enrolamientos: en A la persona es «15»; en B (otra numeración) es el «915» crudo ──
        const [devA] = await trx('hr.attendance_devices').where({ serial_number: A }).select('id');
        const [devB] = await trx('hr.attendance_devices').where({ serial_number: B }).select('id');
        await trx('hr.device_enrollments').insert([
          { tenant_id: TENANT, device_id: devA.id, device_user_id: '15', device_name: 'Uno' },
          { tenant_id: TENANT, device_id: devB.id, device_user_id: '915', person_code: '15', device_name: 'Uno' },
          { tenant_id: TENANT, device_id: devB.id, device_user_id: '15', person_code: '40', device_name: 'Otra persona' },
        ]);

        // ── Renombrar: una orden por reloj, CADA UNA con el código crudo de ese reloj ──────
        const ren = await devices.renombrar({ site_code: site, person_code: '15', name: 'Pérez Ñúñez' });
        r['renombrar'] = [ren.nombre, ren.relojes];
        const pendA = await ingest.ordenesPendientes(A);
        const pendB = await ingest.ordenesPendientes(B);
        r['ordenA'] = pendA.map((o) => [o.empleadoCodigo, o.tipo, (o.payload as { nombre: string }).nombre]);
        r['ordenB'] = pendB.map((o) => o.empleadoCodigo);
        r['otraIntacta'] = (await trx('hr.device_enrollments').where({ device_id: devB.id, device_user_id: '15' }).first('device_name')).device_name;
        // Renombrar otra vez reemplaza la pendiente (no dos escrituras compitiendo en el equipo).
        await devices.renombrar({ site_code: site, person_code: '15', name: 'Perez Nunez II' });
        r['reemplazo'] = [(await ingest.ordenesPendientes(A)).length,
          (await trx('hr.device_commands').where({ device_id: devA.id, status: 'cancelado' }).count<{ n: string }[]>('* as n'))[0].n];

        // ── El agente reporta: error, error, error → se queda en error; el otro sale bien ──
        const [oa] = await ingest.ordenesPendientes(A);
        for (let i = 0; i < 3; i++) await ingest.reportarOrden(oa.id, { estado: 'error', detalle: `intento ${i + 1}` });
        const [ob] = await ingest.ordenesPendientes(B);
        await ingest.reportarOrden(ob.id, { estado: 'hecho', detalle: 'renombrado y verificado', respaldo: { uid: 9, nombre: 'Uno' } });
        const fa = await trx('hr.device_commands').where({ id: oa.id }).first('status', 'attempts', 'completed_at');
        const fb = await trx('hr.device_commands').where({ id: ob.id }).first('status', 'backup', 'requested_by_name');
        r['tresErrores'] = [fa.status, fa.attempts, !!fa.completed_at];
        r['hecho'] = [fb.status, fb.backup, fb.requested_by_name];
        r['reportarOtraVez'] = await fallo(() => ingest.reportarOrden(oa.id, { estado: 'hecho' }));
        r['estadoInvalido'] = await fallo(() => ingest.reportarOrden(oa.id, { estado: 'quien-sabe' }));

        // ── Cancelar sólo lo pendiente ──────────────────────────────────────────────────
        await devices.renombrar({ site_code: site, person_code: '15', name: 'Tres' });
        const [oc] = await ingest.ordenesPendientes(A);
        await devices.cancelar(oc.id);
        r['cancelar'] = [(await ingest.ordenesPendientes(A)).length, await fallo(() => devices.cancelar(oc.id))];

        // ── Restaurar: con el respaldo de un borrado hecho; sin respaldo, 404 ───────────
        r['restaurarSinRespaldo'] = await fallo(() => devices.restaurar({ site_code: site, person_code: '15' }));
        await trx('hr.device_commands').insert({
          tenant_id: TENANT, device_id: devB.id, device_user_id: '915', command: 'borrar', status: 'hecho',
          attempts: 1, backup: JSON.stringify({ crudo: 'AAEC', uid: 9 }), completed_at: trx.fn.now(),
        });
        const res = await devices.restaurar({ site_code: site, person_code: '15' });
        const orest = (await ingest.ordenesPendientes(B)).find((o) => o.tipo === 'restaurar_usuario');
        r['restaurar'] = [res.relojes, orest?.tipo, orest?.empleadoCodigo, !!(orest?.payload as { respaldo?: unknown })?.respaldo];

        // ── Lo que ve RH ────────────────────────────────────────────────────────────────
        const vista = await devices.ordenes({ site_code: site, person_code: '15' });
        r['vista'] = [(vista.relojes as unknown[]).length, (vista.ordenes as unknown[]).length > 0];
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }

    expect(r['sinRegistrar']).toBe('serie_desconocida');
    expect(r['pendientes']).toEqual([2]);
    expect(r['altaMala']).toEqual(['400', '404', '400']);
    expect(r['listado']).toBe(2);
    expect(r['reproceso']).toEqual([1, 1, 2]);
    expect(r['loteReprocesado']).toEqual(['aplicado', null, true]);
    expect(r['repetirReproceso']).toBe(0);
    expect(r['semaforo']).toEqual(['ok', 'mudo']);
    expect(r['renombrar']).toEqual(['Perez Nunez', 2]);
    expect(r['ordenA']).toEqual([['15', 'renombrar_usuario', 'Perez Nunez']]);
    // En el reloj B la persona es el «915»: el «15» de B es OTRA persona y no se toca.
    expect(r['ordenB']).toEqual(['915']);
    expect(r['otraIntacta']).toBe('Otra persona');
    expect(r['reemplazo']).toEqual([1, '1']);
    expect(r['tresErrores']).toEqual(['error', 3, true]);
    expect(r['hecho']).toEqual(['hecho', { uid: 9, nombre: 'Uno' }, 'rh_a']);
    expect(r['reportarOtraVez']).toBe('sin error');
    expect(r['estadoInvalido']).toBe('400');
    expect(r['cancelar']).toEqual([0, '409']);
    expect(r['restaurarSinRespaldo']).toBe('404');
    expect(r['restaurar']).toEqual([1, 'restaurar_usuario', '915', true]);
    expect(r['vista']).toEqual([2, true]);
  }, 120000);
});
