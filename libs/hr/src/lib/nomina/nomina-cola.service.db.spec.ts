/**
 * `[NE.2.5]` La cola de los que no ligaron, **contra Postgres de verdad**: qué muestra, qué
 * escribe, qué se niega a pisar, y que la base misma rechace un alias manual sin firma.
 *
 *   HR_DB_TEST_URL=postgres://…/una_base_de_pruebas npx vitest run -c libs/hr/vitest.config.ts nomina-cola
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara **NO MEDIDO**:
 * un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra una base real
 * (regla 13), y un verde inventado es peor que un hueco declarado.
 *
 * ⛔ Todos los nombres son INVENTADOS: el repo es público.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const RAIZ = path.resolve(__dirname, '../../../../..');
const mig = (n: string) => require(path.join(RAIZ, 'database/migrations-newdb', `${n}.js`));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[NE.2.5] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la cola contra la base.');

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
  await trx.raw(`CREATE TABLE IF NOT EXISTS contpaqi_ods.v_nomina_empleado (employee_code text, full_name text, status text)`);
  await trx.raw(`CREATE TABLE IF NOT EXISTS contpaqi_ods.v_nomina_pago_periodo (employee_code text, paid_on date)`);

  // ⛔ No se consulta `knex_migrations` «y si truena, catch»: en Postgres cualquier error aborta la
  //    transacción entera. Se pregunta primero si la tabla existe.
  const hayRegistro = (await trx.raw(`SELECT to_regclass('public.knex_migrations') AS t`)).rows[0]?.t !== null;
  const aplicadas = new Set<string>(
    hayRegistro
      ? (await trx.raw(`SELECT name FROM public.knex_migrations`)).rows.map((x: { name: string }) => String(x.name).replace(/\.js$/, ''))
      : [],
  );
  const hayUserId = async () => (await trx.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='hr' AND table_name='person_aliases' AND column_name='user_id'`,
  )).rows.length > 0;
  for (const m of ['20261123100533_ne04_periodos_de_nomina_y_alias_de_persona', '20261124120236_ne013_alias_apunta_al_padron_que_existe']) {
    if (await hayUserId()) break;
    if (!aplicadas.has(m)) await mig(m).up(trx);
  }
  // `[NE.2.5]` la firma. Se aplica aparte: su `up` es idempotente y mira el catálogo.
  const NE25 = '20261125083440_ne25_alias_manual_exige_firma';
  if (!aplicadas.has(NE25)) await mig(NE25).up(trx);
}

/** Qué error tiró una llamada que DEBÍA fallar. `null` si no falló, que es el caso interesante. */
async function elError(fn: () => Promise<unknown>): Promise<{ nombre: string; codigo?: string } | null> {
  try { await fn(); return null; } catch (e) {
    const err = e as { constructor: { name: string }; code?: string };
    return { nombre: err.constructor.name, codigo: err.code };
  }
}

suite('la cola de nómina contra la base', () => {
  it('muestra el caso con sus candidatos, lo resuelve firmado, y NO pisa lo que no se vio', async () => {
    const { HrNominaPuenteService } = await import('./nomina-puente.service');
    const { HrNominaColaService } = await import('./nomina-cola.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        await fixture(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

        const sello = Date.now();
        const ids: Record<string, string> = {};
        for (const [k, nombre, status] of [
          ['uno', `NECOLA UNO ${sello}`, 'invited'],
          ['dos', `NECOLA UNO ${sello}`, 'invited'],   // mismo nombre: nadie destaca → ambiguo
          ['firmante', `NECOLA QUIEN FIRMA ${sello}`, 'active'],
        ] as Array<[string, string, string]>) {
          const [u] = await trx('identity.users').insert({ tenant_id: TENANT, nombre, status, kind: 'interno' }).returning('id');
          ids[k] = String(typeof u === 'object' ? (u as { id: string }).id : u);
        }

        const ctx = {
          get: () => ({ tenantId: TENANT, userId: ids['firmante'], username: 'ne_prueba' }),
          requireTenantId: () => TENANT,
        };
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const svc = new HrNominaColaService(tk as never, ctx as never, new HrNominaPuenteService(tk as never, ctx as never));

        const hoy = new Date().toISOString().slice(0, 10);
        const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        await trx('contpaqi_ods.v_nomina_empleado').insert([
          { employee_code: `A${sello}`, full_name: `NECOLA UNO ${sello}`, status: 'A' },
          { employee_code: `D${sello}`, full_name: `NECOLA NADIE ASI ${sello}`, status: 'A' },
        ]);
        await trx('contpaqi_ods.v_nomina_pago_periodo').insert([
          { employee_code: `A${sello}`, paid_on: hoy },
          { employee_code: `A${sello}`, paid_on: ayer },   // dos pagos: la cola los cuenta
          // ⛔⛔ PRUEBA NEGATIVA DEL GRANO: la vista real registra **cada pago hasta tres veces**
          //    (3.000 filas por persona y fecha entre 2019 y 2024; dejó de hacerlo el 2026-10-30).
          //    Estas dos copias del pago de hoy NO deben contar: un pago es una FECHA, no una fila.
          //    Con `count(*)` la pantalla decía 18 pagos donde había 11. → VERDAD_ABSOLUTA §40.8.
          { employee_code: `A${sello}`, paid_on: hoy },
          { employee_code: `A${sello}`, paid_on: hoy },
          { employee_code: `D${sello}`, paid_on: hoy },
        ]);

        const mio = (c: { codigo: string }) => c.codigo.endsWith(String(sello));
        const cola = await svc.cola(30);
        const ambiguo = cola.casos.filter(mio).find((c) => c.codigo.startsWith('A'));
        const solo = cola.casos.filter(mio).find((c) => c.codigo.startsWith('D'));

        r['ambiguoNombre'] = ambiguo?.nombreNomina;
        r['ambiguoMotivo'] = ambiguo?.motivo;
        r['ambiguoPagos'] = ambiguo?.pagos;
        r['ambiguoUltimo'] = ambiguo?.ultimoPago;
        // ⭐ Los candidatos vienen CON NOMBRE y con su estado: es lo que permite decidir.
        r['ambiguoCandidatos'] = (ambiguo?.candidatos ?? [])
          .map((c) => [c.userId === ids['uno'] ? 'uno' : c.userId === ids['dos'] ? 'dos' : 'otro', c.nombre, c.status, c.codigosYaLigados.length])
          .sort();
        // ⛔ NEGATIVA: sin candidatos, la lista va VACÍA. No se rellena con el parecido más cercano.
        r['sinCandidatoMotivo'] = solo?.motivo;
        r['sinCandidatoCandidatos'] = solo?.candidatos.length;

        // ── Resolver, firmado ────────────────────────────────────────────────────────────────
        const res = await svc.resuelve({ codigo: `A${sello}`, userId: ids['uno'], nota: 'Es la misma persona: lo confirmó RH con su expediente.' });
        const fila = await trx('hr.person_aliases').where({ id: res.aliasId }).first('matched_by', 'matched_note', 'created_by', 'user_id', 'is_active');
        r['escrito'] = [
          String(fila?.['matched_by']),
          String(fila?.['created_by']) === ids['firmante'],
          String(fila?.['user_id']) === ids['uno'],
          fila?.['is_active'],
          String(fila?.['matched_note']).startsWith('Es la misma persona'),
        ];
        r['reemplazadoPrimera'] = res.reemplazado;

        // ⭐ IDEMPOTENTE: resolver lo mismo otra vez no escribe otro alias.
        const otra = await svc.resuelve({ codigo: `A${sello}`, userId: ids['uno'], nota: 'Es la misma persona: lo confirmó RH con su expediente.' });
        r['mismoAlias'] = otra.aliasId === res.aliasId;
        r['cuantosActivos'] = Number((await trx('hr.person_aliases')
          .where({ tenant_id: TENANT, system: 'contpaqi', external_code: `A${sello}`, is_active: true }).count({ n: '*' }))[0]?.['n']);

        // ⛔ NEGATIVA: ligarlo a otra persona SIN declarar a quién apunta hoy se rechaza.
        r['sinDeclarar'] = await elError(() => svc.resuelve({ codigo: `A${sello}`, userId: ids['dos'], nota: 'Me equivoqué, es la otra.' }));
        // ⛔ NEGATIVA: declarando MAL a quién apunta (cambió mientras tanto) también se rechaza.
        r['declaraMal'] = await elError(() => svc.resuelve({ codigo: `A${sello}`, userId: ids['dos'], nota: 'Me equivoqué, es la otra.', reemplazaA: ids['firmante'] }));
        r['siguePrimera'] = String((await trx('hr.person_aliases')
          .where({ tenant_id: TENANT, system: 'contpaqi', external_code: `A${sello}`, is_active: true }).first('user_id'))?.['user_id']) === ids['uno'];

        // ✔ Declarándolo bien: el viejo se DESACTIVA (no se borra) y entra el nuevo.
        const corregido = await svc.resuelve({ codigo: `A${sello}`, userId: ids['dos'], nota: 'Me equivoqué, es la otra: lo revisó RH.', reemplazaA: ids['uno'] });
        r['reemplazoDevuelto'] = corregido.reemplazado === res.aliasId;
        r['viejoSigueAhi'] = (await trx('hr.person_aliases').where({ id: res.aliasId }).first('is_active'))?.['is_active'];
        r['activoAhora'] = String((await trx('hr.person_aliases')
          .where({ tenant_id: TENANT, system: 'contpaqi', external_code: `A${sello}`, is_active: true }).first('user_id'))?.['user_id']) === ids['dos'];

        // ⛔ NEGATIVAS de entrada: nota de relleno, código que nadie cobra, persona inexistente.
        r['notaPobre'] = await elError(() => svc.resuelve({ codigo: `D${sello}`, userId: ids['uno'], nota: 'ok' }));
        r['codigoAjeno'] = await elError(() => svc.resuelve({ codigo: `ZZZ${sello}`, userId: ids['uno'], nota: 'cualquier cosa razonable' }));
        r['personaAjena'] = await elError(() => svc.resuelve({ codigo: `D${sello}`, userId: '00000000-0000-0000-0000-0000000000ff', nota: 'cualquier cosa razonable' }));

        // ⛔⛔ NEGATIVA A NIVEL BASE: la migración `ne25` tiene que rechazar un manual SIN firma,
        //     aunque el insert venga por fuera del servicio. Un gate sin prueba negativa es una
        //     intención. Cada intento va en su savepoint: un error aborta la transacción entera.
        r['sinNota'] = await elError(() => trx.transaction((sp) => sp('hr.person_aliases').insert({
          tenant_id: TENANT, user_id: ids['uno'], system: 'contpaqi', external_code: `X1${sello}`,
          matched_by: 'manual', matched_note: null, created_by: ids['firmante'],
        })));
        r['notaEnBlanco'] = await elError(() => trx.transaction((sp) => sp('hr.person_aliases').insert({
          tenant_id: TENANT, user_id: ids['uno'], system: 'contpaqi', external_code: `X2${sello}`,
          matched_by: 'manual', matched_note: '   ', created_by: ids['firmante'],
        })));
        r['sinAutor'] = await elError(() => trx.transaction((sp) => sp('hr.person_aliases').insert({
          tenant_id: TENANT, user_id: ids['uno'], system: 'contpaqi', external_code: `X3${sello}`,
          matched_by: 'manual', matched_note: 'una nota de verdad', created_by: null,
        })));
        // ✔ CONTROL: con nota y autor, la misma fila SÍ entra. Sin esto, los tres rojos de arriba
        //   podrían venir de cualquier otra cosa.
        r['conFirmaEntra'] = await elError(() => trx.transaction((sp) => sp('hr.person_aliases').insert({
          tenant_id: TENANT, user_id: ids['uno'], system: 'contpaqi', external_code: `X4${sello}`,
          matched_by: 'manual', matched_note: 'una nota de verdad', created_by: ids['firmante'],
        })));

        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    // ── La cola dice lo suficiente para decidir ────────────────────────────────────────────────
    expect(r['ambiguoMotivo']).toBe('ambiguo');
    expect(String(r['ambiguoNombre'])).toContain('NECOLA UNO');
    expect(r['ambiguoPagos']).toBe(2);
    expect(r['ambiguoUltimo']).toBe(new Date().toISOString().slice(0, 10));
    expect((r['ambiguoCandidatos'] as unknown[]).length).toBe(2);
    expect((r['ambiguoCandidatos'] as string[][]).map((c) => c[0]).sort()).toEqual(['dos', 'uno']);
    expect((r['ambiguoCandidatos'] as unknown[][]).every((c) => c[2] === 'invited' && c[3] === 0)).toBe(true);
    // ⛔ Sin candidatos, lista vacía.
    expect(r['sinCandidatoMotivo']).toBe('sin-candidato');
    expect(r['sinCandidatoCandidatos']).toBe(0);

    // ── Lo que escribe lleva firma ─────────────────────────────────────────────────────────────
    expect(r['escrito']).toEqual(['manual', true, true, true, true]);
    expect(r['reemplazadoPrimera']).toBeNull();
    expect(r['mismoAlias']).toBe(true);
    expect(r['cuantosActivos']).toBe(1);

    // ── Lo que se niega a pisar ────────────────────────────────────────────────────────────────
    expect((r['sinDeclarar'] as { nombre: string })?.nombre).toBe('ConflictException');
    expect((r['declaraMal'] as { nombre: string })?.nombre).toBe('ConflictException');
    expect(r['siguePrimera']).toBe(true);
    expect(r['reemplazoDevuelto']).toBe(true);
    expect(r['viejoSigueAhi']).toBe(false);   // desactivado, no borrado
    expect(r['activoAhora']).toBe(true);

    expect((r['notaPobre'] as { nombre: string })?.nombre).toBe('BadRequestException');
    expect((r['codigoAjeno'] as { nombre: string })?.nombre).toBe('NotFoundException');
    expect((r['personaAjena'] as { nombre: string })?.nombre).toBe('NotFoundException');

    // ── La base misma rechaza un manual sin firma (23514 = check_violation) ────────────────────
    expect((r['sinNota'] as { codigo?: string })?.codigo).toBe('23514');
    expect((r['notaEnBlanco'] as { codigo?: string })?.codigo).toBe('23514');
    expect((r['sinAutor'] as { codigo?: string })?.codigo).toBe('23514');
    expect(r['conFirmaEntra']).toBeNull();
  }, 60000);
});
