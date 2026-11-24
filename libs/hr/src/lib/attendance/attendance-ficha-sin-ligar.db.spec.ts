/**
 * `[RH.20.1]` La ficha de Asistencia se edita también a quien el reloj trae SIN LIGAR (David, 2026-11-24: «quiero que a
 * todos se les pueda modificar aunque no estén en la Suite»), contra Postgres y con el payload de la pantalla:
 *
 *   · guardar nombre + sección (+ departamento) de un código sin dueño DA DE ALTA a la persona sin acceso, le liga el
 *     código en TODOS los relojes de la plaza y aplica lo demás, con su asiento;
 *   · ⛔ sin nombre completo, o sin sección, no da de alta a nadie (las reglas del alta de Relojes);
 *   · ⛔ un código que no está en ningún reloj de la plaza sigue siendo «no existe»;
 *   · sólo sección/promotora de un código sin dueño se guarda por código, SIN crear persona.
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
const RAIZ = path.resolve(__dirname, '../../../../..');
const mig = (n: string) => require(path.join(RAIZ, 'database/migrations-newdb', `${n}.js`));
const FASE = [
  '20261007100000_hr_relojes_y_checadas', '20261007110000_hr_horarios_y_alertas', '20261007304401_hr_incidencias_y_cierres',
  '20261008094812_hr_agente_corridas', '20261008094813_hr_ordenes_quien',
];

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.20.1] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la ficha sin ligar contra la base.');

async function prepararEsquema(trx: Knex.Transaction) {
  const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((r: { name: string }) => r.name.replace(/\.js$/, '')));
  const hashNullable = (await trx.raw(`SELECT is_nullable FROM information_schema.columns
     WHERE table_schema='identity' AND table_name='users' AND column_name='password_hash'`)).rows[0]?.is_nullable === 'YES';
  for (const m of FASE) if (!aplicadas.has(m)) await mig(m).up(trx);
  if (!hashNullable) await mig('20260910120000_kind_dispositivo_y_hash_nullable').up(trx);
  for (const m of ['20261012094356_rh_personas_bajas_y_sin_acceso', '20261012151620_hr_secciones_por_ficha']) if (!aplicadas.has(m)) await mig(m).up(trx);
}

suite('[RH.20.1] la ficha de quien no está en la Suite, contra la base', () => {
  it('sin ligar: guardar da de alta y liga; ⛔ sin nombre o sin sección no; sección sola no crea a nadie', async () => {
    const { HrAttendanceEnrollmentsService } = await import('./attendance-enrollments.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        await prepararEsquema(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        let n = 0;
        const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
          const sp = `sp${++n}`;
          await trx.raw(`SAVEPOINT ${sp}`);
          try { await fn(); await trx.raw(`RELEASE SAVEPOINT ${sp}`); return 'sin error'; } catch (e) {
            await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
            return (e as { constructor?: { name?: string } }).constructor?.name ?? 'error';
          }
        };
        const sello = String(Date.now()).slice(-7);
        const SITIO = `rh20-${sello}`;
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: SITIO, name: 'Plaza de prueba', warehouse_code: '03' });
        const reloj = async (s: string) => String((await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: `RH20${s}${sello}`, site_code: SITIO, label: `Reloj ${s}` }).returning('id'))[0].id);
        const A = await reloj('A');
        const B = await reloj('B');
        const sinDueno = async (dev: string, code: string, apodo: string) =>
          trx('hr.device_enrollments').insert({ tenant_id: TENANT, device_id: dev, device_user_id: code, device_name: apodo, user_id: null, match_status: 'pendiente', last_seen_at: new Date() });
        await sinDueno(A, '50', 'PEPE');
        await sinDueno(B, '50', 'PEPE');      // el mismo código en los dos relojes de la plaza
        await sinDueno(A, '51', 'MARY');
        await trx('identity.departments').insert({ tenant_id: TENANT, code: `dep20_${sello}`, name: 'Departamento de prueba' });
        const actor = String((await trx('identity.users').insert({
          tenant_id: TENANT, username: `rh20.actor.${sello}`, password_hash: null, nombre: 'Actor Prueba', role_name: 'sin_acceso', kind: 'interno', status: 'invited',
        }).returning('id'))[0].id);

        const tk = { run: async (t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => { await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]); return cb(trx); } };
        const tenantCtx = { requireTenantId: () => TENANT, get: () => ({ userId: actor, username: 'rh.prueba' }) };
        const svc = new HrAttendanceEnrollmentsService(tk as never, tenantCtx as never);
        const personas = async () => Number((await trx('identity.users').where({ tenant_id: TENANT }).count('* as n'))[0]['n']);

        // ⛔ NEGATIVAS: sin nombre completo o sin sección, no hay alta (y no queda nada a medias).
        const antes = await personas();
        r['sinNombre'] = await fallo(() => svc.editarFicha({ site_code: SITIO, person_code: '50', nombre: 'Pepe', seccion: 'ALMACEN' }));
        r['sinSeccion'] = await fallo(() => svc.editarFicha({ site_code: SITIO, person_code: '50', nombre: 'José Pérez Prueba' }));
        r['noExiste'] = await fallo(() => svc.editarFicha({ site_code: SITIO, person_code: '404', nombre: 'Nadie Nadie Prueba', seccion: 'ALMACEN' }));
        r['sinCambio'] = (await personas()) - antes;

        // ⭐ Con el payload de la pantalla: nombre + sección + departamento → alta, liga en los DOS relojes, departamento puesto.
        const res = await svc.editarFicha({ site_code: SITIO, person_code: '50', nombre: 'josé pérez prueba', seccion: 'ALMACEN', departamento_code: `dep20_${sello}` });
        const ligados = await trx('hr.device_enrollments').whereIn('device_id', [A, B]).where({ device_user_id: '50' }).select('user_id');
        const uid = ligados[0]?.user_id as string | undefined;
        const u = uid ? await trx('identity.users').where({ id: uid }).first('nombre', 'role_name', 'status', 'department_code') : null;
        r['alta'] = [res.nombre, ligados.length, new Set(ligados.map((x) => x.user_id)).size, u?.role_name, u?.status, u?.department_code];
        r['eventos'] = uid ? (await trx('identity.user_events').where({ user_id: uid }).orderBy('created_at').pluck('event')).sort() : [];
        r['ficha'] = (await svc.ficha(SITIO, '50')).user_id === uid;

        // Sólo sección de un código sin dueño: se guarda por código, sin crear persona.
        const antes2 = await personas();
        await svc.editarFicha({ site_code: SITIO, person_code: '51', seccion: 'VENTAS' });
        r['soloSeccion'] = [(await personas()) - antes2,
          (await trx('hr.person_site_profiles').where({ tenant_id: TENANT, site_code: SITIO, person_code: '51' }).first('report_section'))?.report_section];
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['sinNombre']).toBe('BadRequestException');
    expect(r['sinSeccion']).toBe('BadRequestException');
    expect(r['noExiste']).toBe('ConflictException');
    expect(r['sinCambio']).toBe(0);
    expect(r['alta']).toEqual(['José Pérez Prueba', 2, 1, 'sin_acceso', 'invited', expect.stringMatching(/^dep20_/)]);
    expect(r['eventos']).toEqual(['alta_desde_reloj', 'ficha_plaza_editada']);
    expect(r['ficha']).toBe(true);
    expect(r['soloSeccion']).toEqual([0, 'VENTAS']);
  }, 60_000);
});
