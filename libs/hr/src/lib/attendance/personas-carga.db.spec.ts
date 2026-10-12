/**
 * `[RH.1.4]` La carga de personas contra Postgres: crea, liga, reusa, NO toca lo ambiguo, y las bajas
 * sin contraseña caben gracias a la migración.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local npx vitest run -c libs/hr/vitest.config.ts personas-carga.db
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
const P = require(path.join(RAIZ, 'database/scripts/rh/carga-personas-mega-talento.js'));
const fase = [
  '20261007100000_hr_relojes_y_checadas',
  '20261007110000_hr_horarios_y_alertas',
  '20261007304401_hr_incidencias_y_cierres',
  '20261008094812_hr_agente_corridas',
  '20261008094813_hr_ordenes_quien',
];

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.1.4] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la carga de personas contra la base.');

/**
 * Los `.db.spec` de hr corren en paralelo y, en una base local atrasada, cada uno crea las tablas de la
 * fase dentro de su transacción: dos a la vez pueden caer en `deadlock detected` (40P01). Se reintenta
 * ESO y nada más; cualquier otro error sale tal cual.
 */
async function conReintento<T>(fn: () => Promise<T>, intentos = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if ((e as { code?: string }).code !== '40P01' || i >= intentos) throw e;
      await new Promise((res) => setTimeout(res, 300 * i));
    }
  }
}

/** Prepara la base local hasta donde la carga la necesita (la local puede ir atrasada). */
async function prepararEsquema(trx: Knex.Transaction, conPersonas: boolean) {
  const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((r: { name: string }) => r.name.replace(/\.js$/, '')));
  const hashNullable = (await trx.raw(`SELECT is_nullable FROM information_schema.columns
     WHERE table_schema='identity' AND table_name='users' AND column_name='password_hash'`)).rows[0]?.is_nullable === 'YES';
  // Primero hr.* y DESPUÉS identity.users: el mismo orden en que los otros `.db.spec` toman los
  // candados. Al revés, dos archivos en paralelo se esperan uno al otro (40P01) en cada reintento.
  for (const m of fase) if (!aplicadas.has(m)) await mig(m).up(trx);
  if (!hashNullable) await mig('20260910120000_kind_dispositivo_y_hash_nullable').up(trx);
  if (conPersonas && !aplicadas.has(P.MIGRACION_PERSONAS)) await mig(P.MIGRACION_PERSONAS).up(trx);
}

suite('carga de personas contra la base', () => {
  it('⛔ NEGATIVA — sin la migración, una baja sin contraseña no cabe', async () => {
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    let codigo = 'sin error';
    try {
      await conReintento(() => knex.transaction(async (trx) => {
        await prepararEsquema(trx, false);
        const ya = (await trx.raw(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
          WHERE conrelid='identity.users'::regclass AND conname='users_hash_solo_falta_si_corresponde'`)).rows[0]?.d ?? '';
        if (/terminated/.test(ya)) { codigo = 'YA_APLICADA'; throw ROLLBACK; }
        try {
          await trx('identity.users').insert({ tenant_id: TENANT, username: `rh-neg-${Date.now()}`, password_hash: null,
            role_name: 'superadmin', kind: 'interno', status: 'terminated', activo: false });
        } catch (e) { codigo = (e as { code?: string }).code ?? 'error'; }
        throw ROLLBACK;
      }));
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }
    // 23514 = check_violation. Si la base ya la tiene aplicada, la negativa no se puede medir aquí.
    if (codigo === 'YA_APLICADA') console.warn('[RH.1.4] NO MEDIDO: la base ya tiene la migración; la negativa no aplica.');
    else expect(codigo).toBe('23514');
  }, 120_000);

  it('crea, liga, reusa y deja fuera lo ambiguo', async () => {
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await conReintento(() => knex.transaction(async (trx) => {
        await prepararEsquema(trx, true);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const sello = Date.now();
        const A = `rh-pers-a-${sello}`, B = `rh-pers-b-${sello}`;
        await trx('hr.attendance_sites').insert([{ tenant_id: TENANT, code: A, name: 'Sitio A' }, { tenant_id: TENANT, code: B, name: 'Sitio B' }]);
        const [dA] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: `RH-P-A-${sello}`, site_code: A }).returning('id');
        const [dB] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: `RH-P-B-${sello}`, site_code: B }).returning('id');
        const enrol = (device: { id: string }, code: string) => ({ tenant_id: TENANT, device_id: device.id, device_user_id: code, match_status: 'pendiente' });
        await trx('hr.device_enrollments').insert([enrol(dA, '1'), enrol(dA, '2'), enrol(dA, '3'), enrol(dA, '4'), enrol(dA, '5'), enrol(dB, '1')]);

        // Una cuenta de la Suite que YA existe con el nombre completo de la ficha A|3,
        // y dos homónimas para la ficha A|4.
        const cuenta = (u: string, nombre: string) => ({ tenant_id: TENANT, username: u, password_hash: 'x', nombre,
          role_name: 'superadmin', kind: 'interno', status: 'active', activo: true, warehouse_code: '99' });
        const [existente] = await trx('identity.users').insert(cuenta(`rh-ex-${sello}`, `Cajera Uno Prueba ${sello}`)).returning('id');
        await trx('identity.users').insert([cuenta(`rh-h1-${sello}`, `Homonima Dos Prueba ${sello}`), cuenta(`rh-h2-${sello}`, `Homonima Dos Prueba ${sello}`)]);

        const mapeo = {
          sitios: { [A]: { warehouse_code: '99', validado: false }, [B]: { warehouse_code: '98', validado: true } },
          departamentos: [{ variantes: ['CAJAS'], department_code: 'cajas', position_code: 'cajera', validado: false }],
        };
        const fichas = [
          { sitio: A, codigo: '1', nombre: 'activa', nombre_completo: `Persona Activa Prueba ${sello}`, departamento: 'Cajas', activo: true },
          { sitio: A, codigo: '2', nombre: 'baja', nombre_completo: `Persona Baja Prueba ${sello}`, departamento: 'Cajas', activo: false, baja_en: '2026-09-01T00:00:00Z' },
          { sitio: A, codigo: '3', nombre: 'cajera', nombre_completo: `Cajera Uno Prueba ${sello}`, departamento: 'Cajas', activo: true },
          { sitio: A, codigo: '4', nombre: 'homonima', nombre_completo: `Homonima Dos Prueba ${sello}`, departamento: 'Cajas', activo: true },
          { sitio: A, codigo: '5', nombre: 'promo', nombre_completo: `Promotora Marca Prueba ${sello}`, departamento: 'ZONA PROMOTORIA', activo: true },
          { sitio: B, codigo: '1', nombre: 'activa', nombre_completo: `Persona Activa Prueba ${sello}`, departamento: null, activo: true },
        ];

        const uno = await P.cargarPersonas(trx, fichas, { mapeo });
        r['cuadre1'] = uno.cuadre;
        r['porDecidir'] = uno.listas.por_decidir.map((x: { codigo: string; motivo: string }) => `${x.codigo}:${x.motivo}`);
        r['repetidas'] = uno.listas.posibles_repetidas.length;
        const persona = async (sitio: string, code: string) => (await trx.raw(`
          SELECT u.id, u.status, u.activo, u.password_hash, u.role_name, u.department_code, u.position_code, u.warehouse_code, u.terminated_at
            FROM hr.device_enrollments e JOIN hr.attendance_devices d ON d.id = e.device_id
            LEFT JOIN identity.users u ON u.id = e.user_id
           WHERE d.site_code = ? AND e.device_user_id = ?`, [sitio, code])).rows[0];
        r['activa'] = await persona(A, '1');
        r['baja'] = await persona(A, '2');
        r['ligadaACuenta'] = (await persona(A, '3')).id === (existente.id ?? existente);
        r['homonimaSinLigar'] = (await persona(A, '4')).id;
        r['promo'] = (await persona(A, '5')).department_code;
        r['otroSitioOtraPersona'] = (await persona(B, '1')).id !== (await persona(A, '1')).id;
        r['sitioConAlmacen'] = (await trx('hr.attendance_sites').where({ code: A }).first('warehouse_code')).warehouse_code;

        // Segunda corrida: todo se reusa, nada nuevo.
        const dos = await P.cargarPersonas(trx, fichas, { mapeo });
        r['cuadre2'] = [dos.cuadre.creadas, dos.cuadre.reusadas, dos.cuadre.enrolamientos_ligados];
        throw ROLLBACK;
      }));
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    const c1 = r['cuadre1'] as Record<string, number>;
    expect([c1['creadas'], c1['creadas_activas'], c1['creadas_bajas'], c1['ligadas_a_cuenta_existente'], c1['por_decidir'], c1['promotoras']])
      .toEqual([4, 3, 1, 1, 1, 1]);
    expect(r['porDecidir']).toEqual(['4:varias_cuentas_con_el_mismo_nombre']);
    expect(r['activa']).toMatchObject({ status: 'invited', activo: false, password_hash: null, role_name: 'sin_acceso', warehouse_code: '99' });
    expect(r['baja']).toMatchObject({ status: 'terminated', activo: false, password_hash: null });
    expect((r['baja'] as { terminated_at: unknown }).terminated_at).not.toBeNull();
    expect(r['ligadaACuenta']).toBe(true);
    expect(r['homonimaSinLigar']).toBeNull();
    expect(r['promo']).toBe('promotoria_marca');
    expect(r['otroSitioOtraPersona']).toBe(true);
    expect(r['repetidas']).toBe(1);
    expect(r['sitioConAlmacen']).toBe('99');
    expect(r['cuadre2']).toEqual([0, 5, 0]);
  }, 120_000);
});
