/**
 * `[NE.2.3]` El servicio del puente **contra Postgres de verdad**: lo que escribe, lo que NO pisa,
 * y que correrlo dos veces no duplique nada.
 *
 *   HR_DB_TEST_URL=postgres://…/una_base_de_pruebas npx vitest run -c libs/hr/vitest.config.ts nomina-puente
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara **NO MEDIDO** —
 * un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra una base real
 * (regla 13), y un verde inventado es peor que un hueco declarado.
 *
 * ⭐ El fixture **se crea lo que le falte**, así que corre igual sobre una base aprovisionada o
 * sobre un clúster desechable recién hecho con `initdb`. Las vistas de `contpaqi_ods` no las crea
 * ninguna migración del repo (las pone el sincronizador de ContPAQi), así que acá se levantan como
 * tablas con la misma forma.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const RAIZ = path.resolve(__dirname, '../../../../..');
const mig = (n: string) => require(path.join(RAIZ, 'database/migrations-newdb', `${n}.js`));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[NE.2.3] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el puente contra la base.');

/** Lo mínimo para que el servicio pueda leer y escribir, si la base no lo trae ya. */
async function fixture(trx: Knex.Transaction): Promise<void> {
  await trx.raw(`CREATE SCHEMA IF NOT EXISTS identity`);
  await trx.raw(`CREATE SCHEMA IF NOT EXISTS hr`);
  await trx.raw(`CREATE SCHEMA IF NOT EXISTS contpaqi_ods`);
  await trx.raw(`CREATE TABLE IF NOT EXISTS identity.tenants (id uuid PRIMARY KEY, name text)`);
  await trx.raw(`
    CREATE TABLE IF NOT EXISTS identity.users (
      id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, nombre text,
      status text, kind text, deleted_at timestamptz,
      CONSTRAINT users_pkey PRIMARY KEY (id),
      CONSTRAINT users_tenant_id_composite UNIQUE (tenant_id, id))`);
  await trx.raw(`CREATE TABLE IF NOT EXISTS hr.employees (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, tenant_id uuid NOT NULL)`);
  await trx.raw(`
    CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
      $fn$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $fn$`);
  await trx.raw(`DO $$ BEGIN CREATE ROLE app_runtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await trx.raw(`INSERT INTO identity.tenants (id, name) VALUES (?, 'pruebas') ON CONFLICT DO NOTHING`, [TENANT]);
  // Las dos vistas de ContPAQi, con la forma que el servicio consulta.
  await trx.raw(`CREATE TABLE IF NOT EXISTS contpaqi_ods.v_nomina_empleado (employee_code text, full_name text, status text)`);
  await trx.raw(`CREATE TABLE IF NOT EXISTS contpaqi_ods.v_nomina_pago_periodo (employee_code text, paid_on date)`);

  // ⛔ No se consulta `knex_migrations` «y si truena, catch»: en Postgres **cualquier error aborta
  //    la transacción entera**, así que el catch salva la promesa y deja la transacción muerta.
  //    Se pregunta primero si la tabla existe.
  const hayRegistro = (await trx.raw(`SELECT to_regclass('public.knex_migrations') AS t`)).rows[0]?.t !== null;
  const aplicadas = new Set<string>(
    hayRegistro
      ? (await trx.raw(`SELECT name FROM public.knex_migrations`)).rows.map((x: { name: string }) => String(x.name).replace(/\.js$/, ''))
      : [],
  );
  for (const m of ['20261123100533_ne04_periodos_de_nomina_y_alias_de_persona', '20261124120236_ne013_alias_apunta_al_padron_que_existe']) {
    const existe = (await trx.raw(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='hr' AND table_name='person_aliases' AND column_name='user_id'`,
    )).rows.length > 0;
    if (existe) break;
    if (!aplicadas.has(m)) await mig(m).up(trx);
  }
}

suite('el puente de padrones contra la base', () => {
  it('escribe lo que liga, no pisa lo ajeno, y correrlo dos veces no duplica', async () => {
    const { HrNominaPuenteService } = await import('./nomina-puente.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        await fixture(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const ctx = { get: () => ({ tenantId: TENANT, userId: null, username: 'ne_prueba' }), requireTenantId: () => TENANT };
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const svc = new HrNominaPuenteService(tk as never, ctx as never);

        const sello = Date.now();
        // ⭐ Tres personas de la Suite: una vigente, una `invited` —que NUNCA entró al sistema y
        //    cobra igual— y una baja. Si el servicio filtrara por «activo», la segunda se perdería.
        const ids: Record<string, string> = {};
        for (const [k, nombre, status] of [
          ['viva', `NEPRUEBA UNO ${sello}`, 'active'],
          ['invitada', `NEPRUEBA DOS ${sello}`, 'invited'],
          ['baja', `NEPRUEBA TRES ${sello}`, 'terminated'],
        ] as Array<[string, string, string]>) {
          const [u] = await trx('identity.users').insert({ tenant_id: TENANT, nombre, status, kind: 'interno' }).returning('id');
          ids[k] = String(typeof u === 'object' ? (u as { id: string }).id : u);
        }

        const hoy = new Date().toISOString().slice(0, 10);
        await trx('contpaqi_ods.v_nomina_empleado').insert([
          { employee_code: `A${sello}`, full_name: `NEPRUEBA UNO ${sello}`, status: 'A' },
          { employee_code: `B${sello}`, full_name: `NEPRUEBA DOS ${sello}`, status: 'B' },
          { employee_code: `C${sello}`, full_name: `NEPRUEBA TRES ${sello}`, status: 'A' },
          { employee_code: `D${sello}`, full_name: `NADIE SE LLAMA ASI ${sello}`, status: 'A' },
        ]);
        await trx('contpaqi_ods.v_nomina_pago_periodo').insert(
          [`A${sello}`, `B${sello}`, `C${sello}`, `D${sello}`].map((employee_code) => ({ employee_code, paid_on: hoy })),
        );

        const mios = (x: { codigo: string }): boolean => x.codigo.endsWith(String(sello));
        const previo = await svc.calcula(30);
        r['ligadosCalculados'] = previo.rechazos.length >= 0;
        r['rechazosMios'] = previo.rechazos.filter(mios).map((x) => [x.codigo.replace(String(sello), ''), x.motivo]).sort();

        const uno = await svc.registra(30);
        r['insertadosPrimera'] = (await trx('hr.person_aliases').where({ tenant_id: TENANT, system: 'contpaqi' })
          .whereIn('external_code', [`A${sello}`, `B${sello}`, `C${sello}`, `D${sello}`]).select('external_code', 'user_id'))
          .map((f) => [String(f['external_code']).replace(String(sello), ''), String(f['user_id']) === ids['viva'] ? 'viva' : String(f['user_id']) === ids['invitada'] ? 'invitada' : 'otra'])
          .sort();
        r['cierraPrimera'] = uno.resumen.cierra;

        // ⭐ IDEMPOTENCIA: la segunda corrida no inserta de nuevo.
        const dos = await svc.registra(30);
        r['segundaInsertaMios'] = (await trx('hr.person_aliases').where({ tenant_id: TENANT, system: 'contpaqi' })
          .whereIn('external_code', [`A${sello}`, `B${sello}`]).count({ n: '*' }))[0]?.['n'];
        r['segundaYaEstaban'] = dos.yaEstaban >= 2;
        r['segundaNoTocados'] = dos.noTocados;

        // ⛔ NEGATIVA: si el alias ya apunta a OTRA persona, no se pisa — se reporta.
        await trx('hr.person_aliases').where({ tenant_id: TENANT, system: 'contpaqi', external_code: `A${sello}` })
          .update({ user_id: ids['baja'] });
        const tres = await svc.registra(30);
        r['conflictoReportado'] = tres.conflictos.filter(mios).map((c) => [c.codigo.replace(String(sello), ''), c.userIdRegistrado === ids['baja'], c.userIdCalculado === ids['viva']]);
        r['noSePiso'] = String((await trx('hr.person_aliases')
          .where({ tenant_id: TENANT, system: 'contpaqi', external_code: `A${sello}` }).first('user_id'))?.['user_id']) === ids['baja'];

        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    // La `invited` TIENE que haber ligado: es el defecto que costó medir el puente al 39 %.
    expect(r['insertadosPrimera']).toEqual([['A', 'viva'], ['B', 'invitada']]);
    // La baja no liga (sale como `solo-baja`) y el que no existe, como `sin-candidato`.
    expect(r['rechazosMios']).toEqual([['C', 'solo-baja'], ['D', 'sin-candidato']]);
    expect(r['cierraPrimera']).toBe(true);
    // Idempotente: siguen siendo 2, no 4.
    expect(Number(r['segundaInsertaMios'])).toBe(2);
    expect(r['segundaYaEstaban']).toBe(true);
    expect(r['segundaNoTocados']).toBe(0);
    // Y el conflicto se reporta sin tocar la fila.
    expect(r['conflictoReportado']).toEqual([['A', true, true]]);
    expect(r['noSePiso']).toBe(true);
  }, 60000);
});
