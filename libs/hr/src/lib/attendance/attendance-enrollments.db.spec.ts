/**
 * `[RH.1.12]` Ligar códigos de reloj a personas, contra Postgres:
 *
 *   · La bandeja trae los códigos que checan sin persona —ni la cuenta «Admin» del reloj ni los ignorados— con los
 *     candidatos del motor de personas: su mismo nombre, o su mismo código ya ligado en otro reloj de la plaza.
 *   · Ligar alcanza el código en TODOS los relojes de la plaza, deja `confirmado`, `updated_by` y su asiento.
 *   · ⛔ No pisa el enlace a otra persona sin `reemplazar`; con él, reemplaza y asienta la baja del anterior.
 *   · Desligar pide motivo. Dar de alta crea a la persona sin contraseña ni acceso, con su sección, y la liga.
 *   · De punta a punta: ya ligada, la persona aparece en el padrón de asistencia con su sección (deja de ser
 *     «Empleado N»).
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
if (!URL) console.warn('[RH.1.12] NO MEDIDO: sin HR_DB_TEST_URL no se prueba ligar códigos contra la base.');

/** Igual que `personas-carga.db.spec`: en paralelo, dos archivos que crean la fase pueden chocar (40P01). Se reintenta eso. */
async function conReintento<T>(fn: () => Promise<T>, intentos = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if ((e as { code?: string }).code !== '40P01' || i >= intentos) throw e;
      await new Promise((res) => setTimeout(res, 300 * i));
    }
  }
}

async function prepararEsquema(trx: Knex.Transaction) {
  const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((r: { name: string }) => r.name.replace(/\.js$/, '')));
  const hashNullable = (await trx.raw(`SELECT is_nullable FROM information_schema.columns
     WHERE table_schema='identity' AND table_name='users' AND column_name='password_hash'`)).rows[0]?.is_nullable === 'YES';
  // hr.* primero y después identity.users (el mismo orden que los demás `.db.spec`, para no cruzar candados).
  for (const m of FASE) if (!aplicadas.has(m)) await mig(m).up(trx);
  if (!hashNullable) await mig('20260910120000_kind_dispositivo_y_hash_nullable').up(trx);
  for (const m of ['20261012094356_rh_personas_bajas_y_sin_acceso', '20261012151620_hr_secciones_por_ficha']) if (!aplicadas.has(m)) await mig(m).up(trx);
}

suite('[RH.1.12] ligar códigos de reloj a personas, contra la base', () => {
  it('bandeja con candidatos → ligar (toda la plaza) → no pisar sin reemplazar → desligar → alta → padrón', async () => {
    const { HrAttendanceEnrollmentsService } = await import('./attendance-enrollments.service');
    const reader = await import('./attendance-reader');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await conReintento(() => knex.transaction(async (trx) => {
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
        const SITIO = `rh112-${sello}`;
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: SITIO, name: 'Plaza de prueba', warehouse_code: '03' });
        const reloj = async (s: string) => String((await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: `RH112${s}${sello}`, site_code: SITIO, label: `Reloj ${s}` }).returning('id'))[0].id);
        const A = await reloj('A');
        const B = await reloj('B');
        const usuario = async (nombre: string) => String((await trx('identity.users').insert({
          tenant_id: TENANT, username: `rh112.${nombre.split(' ')[0].toLowerCase()}.${sello}`, password_hash: 'x', nombre, role_name: 'sin_acceso',
          kind: 'interno', status: 'active', warehouse_code: '03',
        }).returning('id'))[0].id);
        const ANA = await usuario('Ana López Ruiz Prueba');
        const BETO = await usuario('Beto Gómez Paz Prueba');
        const enr = async (dev: string, code: string, nombre: string | null, o: Record<string, unknown> = {}) =>
          String((await trx('hr.device_enrollments').insert({ tenant_id: TENANT, device_id: dev, device_user_id: code, device_name: nombre, ...o }).returning('id'))[0].id);
        const e7A = await enr(A, '7', 'ANA LOPEZ RUIZ PRUEBA');
        const e7B = await enr(B, '7', 'ANA L');
        const e9A = await enr(A, '9', 'BETO', { user_id: BETO, match_status: 'confirmado' });
        const e9B = await enr(B, '9', 'BETO');
        await enr(A, '1', 'Admin');
        await enr(A, '5', 'YA NO TRABAJA', { match_status: 'ignorado' });
        const ahora = Date.now();
        for (const h of [1, 2]) {
          const t = new Date(ahora - h * 3600_000);
          await trx('hr.attendance_logs').insert({ tenant_id: TENANT, device_id: A, device_user_id: '7', punched_at: t, punched_local: t });
        }

        const ACTOR = BETO; // quien opera la pantalla (en la prueba, cualquier usuario existente)
        const tk = { run: async (t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => { await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]); return cb(trx); } };
        const tenantCtx = { requireTenantId: () => TENANT, get: () => ({ userId: ACTOR, username: 'rh.prueba' }) };
        const svc = new HrAttendanceEnrollmentsService(tk as never, tenantCtx as never);

        // ── La bandeja ─────────────────────────────────────────────────────────────────────────────────────────
        const b = await svc.sinPersona();
        const mias = b.filas.filter((f) => f.site_code === SITIO);
        r['bandeja'] = mias.map((f) => f.enrollment_id).sort();
        const f7 = mias.find((f) => f.enrollment_id === e7A);
        r['f7'] = [f7?.checadas_14d, !!f7?.ultima_checada, f7?.candidatos[0]?.user_id === ANA, f7?.candidatos[0]?.motivo, f7?.candidatos[0]?.sugerido];
        const f9 = mias.find((f) => f.enrollment_id === e9B);
        r['f9'] = [f9?.candidatos[0]?.user_id === BETO, f9?.candidatos[0]?.motivo, f9?.candidatos[0]?.sugerido];
        r['primero'] = mias[0]?.enrollment_id === e7A; // el que checó más reciente va primero
        r['buscar'] = (await svc.buscar('lopez ana prueba')).map((p) => p.user_id).includes(ANA);

        // ── Ligar: alcanza el código en los dos relojes de la plaza ────────────────────────────────────────────
        r['ligar'] = (await svc.ligar(e7A, { user_id: ANA })).enrolamientos;
        const l7 = await trx('hr.device_enrollments').whereIn('id', [e7A, e7B]).select('user_id', 'match_status', 'updated_by');
        r['l7'] = l7.every((x) => x.user_id === ANA && x.match_status === 'confirmado' && x.updated_by === ACTOR);
        r['evLigar'] = Number((await trx('identity.user_events').where({ user_id: ANA, event: 'reloj_ligado' }).count('* as n'))[0]['n']);
        r['yaNoEnBandeja'] = (await svc.sinPersona()).filas.some((f) => f.enrollment_id === e7A || f.enrollment_id === e7B);

        // ── ⛔ No pisa el enlace a otra persona sin reemplazar ────────────────────────────────────────────────
        r['sinReemplazar'] = await fallo(() => svc.ligar(e9B, { user_id: ANA }));
        r['betoSigue'] = (await trx('hr.device_enrollments').where({ id: e9A }).first('user_id')).user_id === BETO;
        r['reemplazar'] = (await svc.ligar(e9B, { user_id: ANA, reemplazar: true })).enrolamientos;
        r['evBeto'] = Number((await trx('identity.user_events').where({ user_id: BETO, event: 'reloj_desligado' }).count('* as n'))[0]['n']);

        // ── Desligar pide motivo ───────────────────────────────────────────────────────────────────────────────
        r['sinMotivo'] = await fallo(() => svc.desligar(e9A, 'x'));
        r['desligar'] = (await svc.desligar(e9A, 'era otra persona')).enrolamientos;
        r['libres'] = (await trx('hr.device_enrollments').whereIn('id', [e9A, e9B]).select('user_id', 'match_status')).every((x) => !x.user_id && x.match_status === 'pendiente');

        // ── Alta: persona sin acceso, con su sección, ligada ──────────────────────────────────────────────────
        r['altaNombreCorto'] = await fallo(() => svc.alta(e9A, { nombre: 'Carla', seccion: 'Cajas' }));
        r['altaSinSeccion'] = await fallo(() => svc.alta(e9A, { nombre: 'Carla Vega', seccion: '' }));
        r['altaLigado'] = await fallo(() => svc.alta(e7A, { nombre: 'Otra Persona', seccion: 'Cajas' }));
        const alta = await svc.alta(e9A, { nombre: 'Carla Prueba Vega', seccion: ' cajas  piso ', promotora: false });
        const u = await trx('identity.users').where({ id: alta.user_id }).first('username', 'status', 'role_name', 'password_hash', 'warehouse_code', 'activo');
        r['usuario'] = [u.username, u.status, u.role_name, u.password_hash, u.warehouse_code, u.activo];
        r['altaEnr'] = alta.enrolamientos;
        r['ficha'] = (await trx('hr.person_site_profiles').where({ tenant_id: TENANT, site_code: SITIO, person_code: '9' }).first('report_section', 'is_promoter')) ?? null;
        r['evAlta'] = Number((await trx('identity.user_events').where({ user_id: alta.user_id, event: 'alta_desde_reloj' }).count('* as n'))[0]['n']);
        r['altaRepetida'] = await fallo(() => svc.alta(e9A, { nombre: 'Carla Prueba Vega', seccion: 'Cajas' }));
        r['personaInexistente'] = await fallo(() => svc.ligar(e9A, { user_id: '00000000-0000-4000-8000-000000000000', reemplazar: true }));

        // ── De punta a punta: el padrón de asistencia ya la conoce, con su sección ────────────────────────────
        const p = await reader.padron(trx, SITIO);
        r['padron'] = [p.fichas.get('9')?.nombre, p.fichas.get('9')?.departamento, p.fichas.get('9')?.activo, p.fichas.get('7')?.userId === ANA];
        throw ROLLBACK;
      }));
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }

    expect((r['bandeja'] as string[]).length).toBe(3); // 7A, 7B y 9B; ni «Admin», ni el ignorado, ni 9A (ligado)
    expect(r['f7']).toEqual([2, true, true, 'mismo_nombre', true]);
    expect(r['f9']).toEqual([true, 'mismo_codigo', true]);
    expect(r['primero']).toBe(true);
    expect(r['buscar']).toBe(true);
    expect(r['ligar']).toBe(2);
    expect(r['l7']).toBe(true);
    expect(r['evLigar']).toBe(1);
    expect(r['yaNoEnBandeja']).toBe(false);
    expect(r['sinReemplazar']).toBe('ConflictException');
    expect(r['betoSigue']).toBe(true);
    expect(r['reemplazar']).toBe(2);
    expect(r['evBeto']).toBe(1);
    expect(r['sinMotivo']).toBe('BadRequestException');
    expect(r['desligar']).toBe(2);
    expect(r['libres']).toBe(true);
    expect(r['altaNombreCorto']).toBe('BadRequestException');
    expect(r['altaSinSeccion']).toBe('BadRequestException');
    expect(r['altaLigado']).toBe('ConflictException');
    expect((r['usuario'] as unknown[]).slice(0, 5)).toEqual([expect.stringMatching(/^rh\.rh112-\d+\.9$/), 'invited', 'sin_acceso', null, '03']);
    expect(r['altaEnr']).toBe(2);
    expect(r['ficha']).toEqual({ report_section: 'CAJAS PISO', is_promoter: false });
    expect(r['evAlta']).toBe(1);
    expect(r['altaRepetida']).toBe('ConflictException');
    expect(r['personaInexistente']).toBe('BadRequestException');
    expect(r['padron']).toEqual(['Carla Prueba Vega', 'CAJAS PISO', true, true]);
  }, 120_000);
});
