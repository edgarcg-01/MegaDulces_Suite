/**
 * `[RH.14]` El padrón a cargo de RH, contra Postgres (los endpoints que ESCRIBEN se ejercen con el payload de la pantalla):
 *
 *   · `[RH.14.3]` la ficha trae cada reloj con su número y su apodo, el nombre como quedaría en el reloj y sus plazas activas;
 *   · `[RH.14.5]` RH cambia departamento, puesto y sucursal (y la zona sale de la sucursal) SÓLO de quien no tiene acceso,
 *     con su «antes y después» en la bitácora; ⛔ un código que no existe no se guarda;
 *   · `[RH.14.4]` «nombres por confirmar» trae el apodo del reloj y no al que ya tiene nombre completo;
 *   · `[RH.14.6]` posibles bajas por días sin checar (sin quien tiene vacaciones), y la baja en lote: la que falla no deshace
 *     a las demás;
 *   · `[RH.14.1]` sin plazas → archivar (⛔ no con plazas activas ni con acceso) → reactivar en la plaza la regresa.
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
if (!URL) console.warn('[RH.14] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el padrón de RH contra la base.');

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
  for (const m of FASE) if (!aplicadas.has(m)) await mig(m).up(trx);
  if (!hashNullable) await mig('20260910120000_kind_dispositivo_y_hash_nullable').up(trx);
  for (const m of ['20261012094356_rh_personas_bajas_y_sin_acceso', '20261012151620_hr_secciones_por_ficha']) if (!aplicadas.has(m)) await mig(m).up(trx);
}

suite('[RH.14] el padrón de personas a cargo de RH, contra la base', () => {
  it('ficha → departamento/puesto/sucursal → nombres por confirmar → posibles bajas → lote → archivar → reactivar', async () => {
    const { HrAttendanceEnrollmentsService } = await import('./attendance-enrollments.service');
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
        const SITIO = `rh14-${sello}`;
        const OTRO = `rh14b-${sello}`;
        await trx('hr.attendance_sites').insert([
          { tenant_id: TENANT, code: SITIO, name: 'Plaza de prueba', warehouse_code: '03' },
          { tenant_id: TENANT, code: OTRO, name: 'Otra plaza de prueba', warehouse_code: '03' },
        ]);
        const reloj = async (sitio: string, s: string) => String((await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: `RH14${s}${sello}`, site_code: sitio, label: `Reloj ${s}` }).returning('id'))[0].id);
        const A = await reloj(SITIO, 'A');
        const B = await reloj(SITIO, 'B');
        const C = await reloj(OTRO, 'C');
        const usuario = async (nombre: string, rol = 'sin_acceso') => String((await trx('identity.users').insert({
          tenant_id: TENANT, username: `rh14.${nombre.split(' ')[0].toLowerCase()}.${sello}`, password_hash: null, nombre, role_name: rol,
          kind: 'interno', status: 'invited',
        }).returning('id'))[0].id);
        const CLAU = await usuario('Claudia');                       // apodo del reloj
        const LUIS = await usuario('Luis David Navarro Prueba');     // nombre completo
        const VALE = await usuario('Vale', 'superadmin');            // con acceso: lo cambia Sistemas
        await trx('identity.users').where({ id: VALE }).update({ password_hash: 'x', status: 'active' });
        const enr = async (dev: string, code: string, nombre: string, user: string) =>
          trx('hr.device_enrollments').insert({ tenant_id: TENANT, device_id: dev, device_user_id: code, device_name: nombre, user_id: user, match_status: 'confirmado', last_seen_at: new Date() });
        await enr(A, '1', 'Claudia', CLAU);
        await enr(B, '1', 'CLAUDIA', CLAU);
        await enr(A, '2', 'Luis', LUIS);
        await enr(C, '8', 'Luis', LUIS);                            // Luis también checa en la otra plaza
        await enr(A, '3', 'Vale', VALE);
        const checada = async (dev: string, code: string, diasAtras: number) => {
          const t = new Date(Date.now() - diasAtras * 86_400_000);
          await trx('hr.attendance_logs').insert({ tenant_id: TENANT, device_id: dev, device_user_id: code, punched_at: t, punched_local: t });
        };
        await checada(A, '1', 40);   // Claudia: 40 días sin checar
        await checada(A, '2', 45);   // Luis: 45 días sin checar aquí, pero tiene vacaciones
        await checada(C, '8', 1);    // … y sigue activo en la otra plaza
        await checada(A, '3', 2);    // Vale checó antier
        await trx('hr.attendance_incidents').insert({ tenant_id: TENANT, site_code: SITIO, person_code: '2', incident_type: 'vacaciones',
          date_from: new Date(Date.now() - 44 * 86_400_000), date_to: new Date(Date.now() + 5 * 86_400_000), status: 'calificada' });

        // Catálogos propios de la prueba (una sucursal con un código de 2 dígitos que no exista).
        const ocupados = new Set((await trx.raw(`SELECT CASE WHEN code ~ '^[0-9]{2}$' THEN code ELSE wincaja_source_branch END AS k FROM commercial.warehouses WHERE tenant_id = ?`, [TENANT])).rows.map((x: { k: string }) => x.k));
        const SUC = ['91', '92', '93', '94', '95', '96', '97', '98', '99'].find((c) => !ocupados.has(c)) as string;
        const zona = await trx('trade.zones').where({ tenant_id: TENANT }).whereNull('deleted_at').first('id');
        await trx('commercial.warehouses').insert({ tenant_id: TENANT, code: SUC, name: 'Sucursal de prueba', zone_id: zona?.id ?? null });
        await trx('identity.departments').insert({ tenant_id: TENANT, code: `dep14_${sello}`, name: 'Departamento de prueba' });
        await trx('identity.positions').insert({ tenant_id: TENANT, code: `pue14_${sello}`, name: 'Puesto de prueba', department_code: `dep14_${sello}` });

        const ACTOR = LUIS;
        const tk = { run: async (t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => { await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]); return cb(trx); } };
        const tenantCtx = { requireTenantId: () => TENANT, get: () => ({ userId: ACTOR, username: 'rh.prueba' }) };
        const svc = new HrAttendanceEnrollmentsService(tk as never, tenantCtx as never);

        // ── [RH.14.3] La ficha: los dos relojes con su apodo, y cómo quedaría su nombre en el reloj ─────────────
        const fc = await svc.ficha(SITIO, '1');
        r['ficha'] = [fc.user_id === CLAU, fc.con_acceso, fc.relojes.length, fc.relojes.map((x) => x.nombre_reloj).sort(), fc.nombre_para_reloj, fc.plazas_activas, fc.activa_en_plaza, fc.nombre_por_confirmar];
        r['fichaLuis'] = (await svc.ficha(SITIO, '2')).nombre_por_confirmar;
        r['fichaVale'] = (await svc.ficha(SITIO, '3')).con_acceso;
        r['fichaNoExiste'] = await fallo(() => svc.ficha(SITIO, '404'));
        const cat = await svc.catalogos();
        r['catalogos'] = [cat.departamentos.some((d) => d.code === `dep14_${sello}`), cat.puestos.some((p) => p.code === `pue14_${sello}` && p.department_code === `dep14_${sello}`), cat.sucursales.some((s) => s.code === SUC)];

        // ── [RH.14.5] Departamento, puesto y sucursal de quien no tiene acceso ────────────────────────────────
        await svc.editarFicha({ site_code: SITIO, person_code: '1', departamento_code: `dep14_${sello}`, puesto_code: `pue14_${sello}`, sucursal_code: SUC });
        const u1 = await trx('identity.users').where({ id: CLAU }).first('department_code', 'position_code', 'warehouse_code', 'zona_id');
        r['persona'] = [u1.department_code, u1.position_code, u1.warehouse_code, u1.zona_id === (zona?.id ?? null)];
        r['depNoExiste'] = await fallo(() => svc.editarFicha({ site_code: SITIO, person_code: '1', departamento_code: 'no_existe_14' }));
        r['sucNoExiste'] = await fallo(() => svc.editarFicha({ site_code: SITIO, person_code: '1', sucursal_code: '00' }));
        r['conAcceso'] = await fallo(() => svc.editarFicha({ site_code: SITIO, person_code: '3', departamento_code: `dep14_${sello}` }));
        r['valeIntacta'] = (await trx('identity.users').where({ id: VALE }).first('department_code')).department_code;
        await svc.editarFicha({ site_code: SITIO, person_code: '1', sucursal_code: null });
        const u2 = await trx('identity.users').where({ id: CLAU }).first('warehouse_code', 'zona_id', 'department_code');
        r['quitarSucursal'] = [u2.warehouse_code, u2.zona_id, u2.department_code];
        const evs = await trx('identity.user_events').where({ user_id: CLAU, event: 'ficha_plaza_editada' }).select('detalle');
        const det = (x: { detalle: unknown }) => (typeof x.detalle === 'string' ? JSON.parse(x.detalle) : x.detalle) as Record<string, Record<string, unknown>>;
        r['bitacora'] = [evs.length, evs.some((x) => det(x)['antes']?.['department_code'] === null && det(x)['despues']?.['department_code'] === `dep14_${sello}`)];

        // ── [RH.14.4] Nombres por confirmar: Claudia y Vale sí (apodo; Vale aunque tenga acceso), Luis no (completo) ──
        const nc = await svc.nombresPorConfirmar(SITIO);
        const mios = nc.filas.filter((x) => [CLAU, LUIS, VALE].includes(x.user_id));
        r['nombres'] = mios.map((x) => [x.user_id === CLAU ? 'clau' : x.user_id === VALE ? 'vale' : 'luis', x.motivo, x.nombre_reloj?.toUpperCase(), x.plazas.map((p) => p.person_code)]);
        // El nombre de Vale (con acceso) se corrige; su departamento no.
        r['nombreVale'] = await fallo(() => svc.editarFicha({ site_code: SITIO, person_code: '3', nombre: 'Valeria Ortiz Prueba' }));

        // ── [RH.14.6] Posibles bajas: Claudia (40 días); Luis no (vacaciones); Vale no (checó antier) ─────────
        const pb = await svc.posiblesBajas(SITIO, '31');
        r['posibles'] = pb.filas.map((x) => [x.person_code, x.dias_sin_checar, x.otras_plazas_activas]);
        r['explicadas'] = pb.explicadas.map((x) => [x.person_code, x.incidencia.etiqueta, x.otras_plazas_activas]);
        r['ventanaLarga'] = (await svc.posiblesBajas(SITIO, '60')).filas.length;

        // Lote: Claudia y Luis se dan de baja; el código 404 falla sin deshacer a los otros.
        r['loteSinMotivo'] = await fallo(() => svc.darDeBajaLote({ site_code: SITIO, person_codes: ['1'], motivo: 'no' }));
        const lote = await svc.darDeBajaLote({ site_code: SITIO, person_codes: ['1', '404', '2'], motivo: 'Sin checar desde hace más de 31 días' });
        r['lote'] = [lote.dados_de_baja.sort(), lote.fallaron.map((f) => f.person_code), lote.sin_plazas.map((s) => [s.user_id === CLAU, s.archivable])];
        r['luisSigue'] = (await trx.raw(`SELECT is_active FROM hr.person_site_profiles WHERE site_code = ? AND person_code = '2'`, [SITIO])).rows[0]?.is_active;

        // ── [RH.14.1] Archivar: ⛔ no a quien tiene plazas activas; sí a Claudia; reactivar la regresa ──────────
        r['archivarLuis'] = await fallo(() => svc.archivar({ user_id: LUIS, motivo: 'ya no trabaja aquí' }));
        r['archivarVale'] = await fallo(() => svc.archivar({ user_id: VALE, motivo: 'ya no trabaja aquí' }));
        await svc.archivar({ user_id: CLAU, motivo: 'Sin checar desde hace más de 31 días' });
        const ua = await trx('identity.users').where({ id: CLAU }).first('status', 'activo');
        r['archivada'] = [ua.status, ua.activo];
        r['archivarDoble'] = await fallo(() => svc.archivar({ user_id: CLAU, motivo: 'otra vez porque sí' }));
        await svc.reactivar({ site_code: SITIO, person_code: '1' });
        const ur = await trx('identity.users').where({ id: CLAU }).first('status', 'terminated_at');
        r['reactivada'] = [ur.status, ur.terminated_at];
        r['eventos'] = (await trx('identity.user_events').where({ user_id: CLAU }).whereIn('event', ['persona_archivada', 'persona_reactivada']).select('event')).map((e: { event: string }) => e.event).sort();
        throw ROLLBACK;
      }));
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }

    expect(r['ficha']).toEqual([true, false, 2, ['CLAUDIA', 'Claudia'], 'Claudia', 1, true, 'apodo_del_reloj']);
    expect(r['fichaLuis']).toBeNull();
    expect(r['fichaVale']).toBe(true);
    expect(r['fichaNoExiste']).toBe('NotFoundException');
    expect(r['catalogos']).toEqual([true, true, true]);
    expect((r['persona'] as unknown[]).slice(0, 2)).toEqual([expect.stringMatching(/^dep14_/), expect.stringMatching(/^pue14_/)]);
    expect((r['persona'] as unknown[]).slice(2)).toEqual([expect.stringMatching(/^9\d$/), true]);
    expect(r['depNoExiste']).toBe('BadRequestException');
    expect(r['sucNoExiste']).toBe('BadRequestException');
    expect(r['conAcceso']).toBe('ConflictException');
    expect(r['valeIntacta']).toBeNull();
    expect(r['quitarSucursal']).toEqual([null, null, expect.stringMatching(/^dep14_/)]);
    expect(r['bitacora']).toEqual([2, true]);
    expect(r['nombres']).toEqual([['clau', 'apodo_del_reloj', 'CLAUDIA', ['1']], ['vale', 'apodo_del_reloj', 'VALE', ['3']]]);
    expect(r['nombreVale']).toBe('sin error');
    expect(r['posibles']).toEqual([['1', 40, 0]]);
    expect(r['explicadas']).toEqual([['2', 'Vacaciones', 1]]);
    expect(r['ventanaLarga']).toBe(0);
    expect(r['loteSinMotivo']).toBe('BadRequestException');
    expect(r['lote']).toEqual([['1', '2'], ['404'], [[true, true]]]);
    expect(r['luisSigue']).toBe(false);
    expect(r['archivarLuis']).toBe('ConflictException');
    expect(r['archivarVale']).toBe('ConflictException');
    expect(r['archivada']).toEqual(['terminated', false]);
    expect(r['archivarDoble']).toBe('ConflictException');
    expect(r['reactivada']).toEqual(['invited', null]);
    expect(r['eventos']).toEqual(['persona_archivada', 'persona_reactivada']);
  }, 120_000);
});
