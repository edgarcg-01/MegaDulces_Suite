/**
 * `[NE.2.2]` El periodo de nómina derivado de ContPAQi, **contra Postgres de verdad**.
 *
 *   HR_DB_TEST_URL=postgres://…/una_base_de_pruebas npx vitest run -c libs/hr/vitest.config.ts nomina-periodos
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara **NO MEDIDO**.
 *
 * Las negativas que importan, y las tres salen de algo medido en prod:
 *  · una fecha que **no cae en viernes** (el miércoles de Semana Santa de 2018) **se omite y se
 *    reporta** — no se fuerza contra el `CHECK` ni se calla;
 *  · un rango que **no alcanza el consenso** entra con `starts_on`/`ends_on` **en NULL**,
 *    declarado, no inventado;
 *  · y aunque alguien saltara el servicio, **el `CHECK` de la base rechaza un pago en martes**.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const RAIZ = path.resolve(__dirname, '../../../../..');
const mig = (n: string) => require(path.join(RAIZ, 'database/migrations-newdb', `${n}.js`));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[NE.2.2] NO MEDIDO: sin HR_DB_TEST_URL no se prueban los periodos contra la base.');

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
  await trx.raw(`
    CREATE TABLE IF NOT EXISTS contpaqi_ods.v_nomina_pago_periodo (
      employee_code text, paid_on date, period_from date, period_to date, payroll_type text)`);

  const hayRegistro = (await trx.raw(`SELECT to_regclass('public.knex_migrations') AS t`)).rows[0]?.t !== null;
  const aplicadas = new Set<string>(
    hayRegistro
      ? (await trx.raw(`SELECT name FROM public.knex_migrations`)).rows.map((x: { name: string }) => String(x.name).replace(/\.js$/, ''))
      : [],
  );
  const hayTabla = (await trx.raw(`SELECT to_regclass('hr.payroll_periods') AS t`)).rows[0]?.t !== null;
  if (!hayTabla && !aplicadas.has('20261123100533_ne04_periodos_de_nomina_y_alias_de_persona')) {
    await mig('20261123100533_ne04_periodos_de_nomina_y_alias_de_persona').up(trx);
    await mig('20261124120236_ne013_alias_apunta_al_padron_que_existe').up(trx);
  }
  // `[NE.2.2]` ensancha el CHECK de `source` para aceptar 'contpaqi'. Idempotente.
  await mig('20261124170500_ne22_periodo_de_nomina_desde_contpaqi').up(trx);
}

suite('el periodo de nómina derivado de ContPAQi', () => {
  it('deriva la semana sábado→viernes, omite lo que no es viernes y declara lo que no puede derivar', async () => {
    const { HrNominaPeriodosService } = await import('./nomina-periodos.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
      try { await fn(); return 'sin error'; } catch (e) { return String((e as { code?: string }).code ?? 'error'); }
    };
    try {
      await knex.transaction(async (trx) => {
        await fixture(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const ctx = { get: () => ({ tenantId: TENANT, userId: null, username: 'ne_prueba' }), requireTenantId: () => TENANT };
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const svc = new HrNominaPeriodosService(tk as never, ctx as never);

        const filas: Array<Record<string, unknown>> = [];
        const pago = (code: string, paid: string, pf: string | null, pt: string | null, tipo = 'O'): void => {
          filas.push({ employee_code: code, paid_on: paid, period_from: pf, period_to: pt, payroll_type: tipo });
        };
        // (1) Viernes limpio: 10 personas con la semana sábado→viernes.
        for (let i = 0; i < 10; i++) pago(`p${i}`, '2026-10-02', '2026-09-26', '2026-10-02');
        // (2) Viernes con una entrada a media semana: el modal sigue mandando (9 de 10).
        for (let i = 0; i < 9; i++) pago(`p${i}`, '2026-10-09', '2026-10-03', '2026-10-09');
        pago('p9', '2026-10-09', '2026-10-07', '2026-10-09');
        // (3) ⛔ Viernes SIN consenso: mitad y mitad, ninguno llega al 80 %.
        for (let i = 0; i < 5; i++) pago(`p${i}`, '2026-10-16', '2026-10-10', '2026-10-16');
        for (let i = 5; i < 10; i++) pago(`p${i}`, '2026-10-16', '2026-10-12', '2026-10-16');
        // (4) ⛔ NO es viernes: el miércoles de Semana Santa, como el caso real de 2018.
        for (let i = 0; i < 4; i++) pago(`p${i}`, '2018-03-28', '2018-03-24', '2018-03-30');
        // (5) ⛔ Extraordinaria (aguinaldo): no es un periodo semanal y no debe entrar.
        for (let i = 0; i < 6; i++) pago(`p${i}`, '2026-12-15', '2026-01-01', '2026-12-15', 'E');
        await trx('contpaqi_ods.v_nomina_pago_periodo').insert(filas);

        const uno = await svc.sincroniza('2017-01-01');
        r['primera'] = { universo: uno.universo, insertados: uno.insertados, conRango: uno.conRango, sinRango: uno.sinRango };
        r['omitidos'] = uno.omitidos.map((o) => [o.paidOn.slice(0, 10), o.motivo]).sort();
        // ⚠️ Una columna `date` llega como objeto `Date`: cortar `String(fecha)` daría «Fri Oct 16».
        const iso = (v: unknown): string | null => (v instanceof Date
          ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
          : v === null || v === undefined ? null : String(v).slice(0, 10));
        r['enLaTabla'] = (await trx('hr.payroll_periods').where({ tenant_id: TENANT }).orderBy('paid_on')
          .select('paid_on', 'starts_on', 'ends_on', 'days', 'source', 'status'))
          .map((f) => [iso(f['paid_on']), iso(f['starts_on']), f['days'], f['source'], f['status']]);

        // ⭐ IDEMPOTENCIA.
        const dos = await svc.sincroniza('2017-01-01');
        r['segunda'] = { insertados: dos.insertados, yaEstaban: dos.yaEstaban };
        r['filasDespues'] = Number((await trx('hr.payroll_periods').where({ tenant_id: TENANT }).count({ n: '*' }))[0]?.['n']);

        // ⛔ NEGATIVA a nivel base: aunque alguien saltara el servicio, el CHECK rechaza un martes.
        r['checkMartes'] = await fallo(() => trx.transaction(async (sp) => {
          await sp('hr.payroll_periods').insert({ tenant_id: TENANT, paid_on: '2026-10-06', status: 'pagado', source: 'contpaqi' });
        }));
        // ⛔ Y rechaza medio rango: o entero, o nada.
        r['checkMedioRango'] = await fallo(() => trx.transaction(async (sp) => {
          await sp('hr.payroll_periods').insert({ tenant_id: TENANT, paid_on: '2026-10-23', starts_on: '2026-10-17', status: 'pagado', source: 'contpaqi' });
        }));
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    // Cuatro fechas ordinarias: tres viernes + el miércoles. La extraordinaria NO entra al universo.
    expect(r['primera']).toEqual({ universo: 4, insertados: 3, conRango: 2, sinRango: 1 });
    expect(r['omitidos']).toEqual([['2018-03-28', 'no-es-viernes']]);
    expect(r['enLaTabla']).toEqual([
      ['2026-10-02', '2026-09-26', 7, 'contpaqi', 'pagado'],
      ['2026-10-09', '2026-10-03', 7, 'contpaqi', 'pagado'],
      // Sin consenso: el rango se DECLARA desconocido en vez de inventarse.
      ['2026-10-16', null, null, 'contpaqi', 'pagado'],
    ]);
    expect(r['segunda']).toEqual({ insertados: 0, yaEstaban: 3 });
    expect(r['filasDespues']).toBe(3);
    // Los dos CHECK de la tabla se ponen rojos (23514 = violación de restricción).
    expect(r['checkMartes']).toBe('23514');
    expect(r['checkMedioRango']).toBe('23514');
  }, 60000);
});
