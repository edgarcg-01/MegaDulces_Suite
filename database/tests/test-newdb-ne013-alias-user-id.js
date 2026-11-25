'use strict';
/**
 * `[NE.0.13]` — ENSAYO DE LA MIGRACIÓN `20261124120236_ne013_alias_apunta_al_padron_que_existe.js`
 * CONTRA UN POSTGRES DE VERDAD.
 *
 * Qué corrige esa migración: `hr.person_aliases` nació (en `[NE.0.4]`, 2026-11-23) con
 * `employee_id` NOT NULL contra `hr.employees` — una tabla con **0 filas y `n_tup_ins = 0`** cuyo
 * único cargador es un importer (regla 1). Con ese FK la tabla **no podía recibir ni una fila**.
 * El padrón de personas de esta suite es `identity.users` (1,038 cargadas por `[RH.1.4]`).
 *
 * ⛔ Esto NO prueba «que no truena»: prueba las POSCONDICIONES leyendo el catálogo, y sobre todo
 * la **negativa funcional** que un ensayo en seco jamás puede dar — que el FK compuesto RECHACE
 * un alias que nombra a una persona de OTRO tenant. Un gate sin prueba negativa es una intención.
 *
 * ⚠️ Es un test que ESCRIBE DDL, así que **se crea su propia base desechable** y la borra al
 * terminar: nunca toca los objetos de la base a la que lo apuntás. Además pasa por
 * `assertSafeTarget`, que se niega contra prod.
 *
 * Uso:
 *     ENSAYO_URL=postgres://postgres@127.0.0.1:55432/postgres \
 *       node database/tests/test-newdb-ne013-alias-user-id.js
 *
 * Sin `ENSAYO_URL` **declara NO MEDIDO** y sale en verde: no hay un clúster de pruebas en el CI
 * para esto, y un verde inventado es peor que un hueco declarado (ADR-056).
 *
 * Cómo tener un clúster en 20 s sin Docker (así se midió el 2026-11-24, con Docker caído porque
 * WSL2 no arranca en esta máquina — la virtualización está apagada en BIOS):
 *     initdb -D <tmp>/pgdata -U postgres --auth=trust
 *     pg_ctl -D <tmp>/pgdata -l <tmp>/pg.log -o "-p 55441 -c listen_addresses=127.0.0.1" start
 *
 * ⛔ **Elegí el puerto comprobando que está libre, y confirmá que el clúster es el tuyo** antes de
 *    medir: `SELECT current_setting('data_directory')` tiene que caer en TU carpeta. Varias
 *    sesiones comparten esta máquina y eligen los mismos puertos; en la primera corrida de este
 *    ensayo `pg_ctl` falló por puerto ocupado **y `psql` conectó igual** — al clúster de otra
 *    sesión. Si `pg_ctl` no arranca pero `psql` contesta en ese puerto, el que contesta es de otro.
 *
 * Medido el 2026-11-24: **28 ✔ · 0 ✖** sobre PostgreSQL 18.4; prod corre 18.6 (misma versión
 * mayor, `system_identifier` verificado).
 */

const path = require('path');
require(path.resolve(__dirname, '../../node_modules/dotenv')).config({
  path: path.resolve(__dirname, '../../.env'),
});
const Knex = require(path.resolve(__dirname, '../../node_modules/knex'));
const { assertSafeTarget } = require('./_lib/assert-safe-target');

const MIGRACIONES = path.resolve(__dirname, '../migrations-newdb');
const ne04 = require(path.join(MIGRACIONES, '20261123100533_ne04_periodos_de_nomina_y_alias_de_persona.js'));
const ne013 = require(path.join(MIGRACIONES, '20261124120236_ne013_alias_apunta_al_padron_que_existe.js'));

const T_MD = '00000000-0000-0000-0000-00000000d01c';
const T_OTRO = '00000000-0000-0000-0000-0000000000ff';
const U_MD = '11111111-1111-1111-1111-111111111111';
const U_OTRO = '22222222-2222-2222-2222-222222222222';

let ok = 0;
let fail = 0;
function assert(cond, nombre, detalle) {
  if (cond) {
    ok++;
    console.log(`  ✔ ${nombre}`);
  } else {
    fail++;
    console.log(`  ✖ ${nombre}${detalle ? `  <- ${detalle}` : ''}`);
  }
}
function noMedido(motivo) {
  console.log(`\n  NO MEDIDO: ${motivo}\n`);
}

/** Como lo corre knex: dentro de una transacción. */
const correr = (knex, fn) => knex.transaction((trx) => fn(trx));

/** Corre algo que DEBE fallar; devuelve el error, o null si (mal) pasó. */
async function debeFallar(knex, fn) {
  try {
    await correr(knex, fn);
    return null;
  } catch (e) {
    return e;
  }
}

/** Lo mínimo de lo que cuelga `hr.person_aliases`. No se clona el esquema entero. */
const FIXTURE = `
  CREATE SCHEMA IF NOT EXISTS identity;
  CREATE SCHEMA IF NOT EXISTS hr;
  CREATE TABLE identity.tenants (id uuid PRIMARY KEY, name text);
  CREATE TABLE identity.users (
    id         uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES identity.tenants(id),
    full_name  text,
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_tenant_id_composite UNIQUE (tenant_id, id)
  );
  CREATE TABLE hr.employees (
    id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id  uuid NOT NULL REFERENCES identity.tenants(id)
  );
  CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
    $fn$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $fn$;
  INSERT INTO identity.tenants (id, name) VALUES ('${T_MD}', 'mega_dulces'), ('${T_OTRO}', 'otro');
  INSERT INTO identity.users (id, tenant_id, full_name)
    VALUES ('${U_MD}', '${T_MD}', 'Persona del tenant bueno'),
           ('${U_OTRO}', '${T_OTRO}', 'Persona de OTRO tenant');
`;

/** Foto del catálogo de `hr.person_aliases`. */
async function foto(knex) {
  const cols = (
    await knex.raw(`SELECT column_name FROM information_schema.columns
                     WHERE table_schema='hr' AND table_name='person_aliases'`)
  ).rows.map((r) => r.column_name);
  const cons = {};
  for (const r of (
    await knex.raw(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                     WHERE conrelid = 'hr.person_aliases'::regclass`)
  ).rows) {
    cons[r.conname] = r.def;
  }
  const idx = (
    await knex.raw(`SELECT indexname FROM pg_indexes
                     WHERE schemaname='hr' AND tablename='person_aliases'`)
  ).rows.map((r) => r.indexname);
  const { rows: [rls] } = await knex.raw(
    `SELECT relrowsecurity AS encendida, relforcerowsecurity AS forzada
       FROM pg_class WHERE oid = 'hr.person_aliases'::regclass`,
  );
  const pol = (
    await knex.raw(`SELECT polname FROM pg_policy WHERE polrelid = 'hr.person_aliases'::regclass`)
  ).rows.map((r) => r.polname);
  return { cols, cons, idx, rls, pol };
}

async function ensayo(knex) {
  console.log('\n[0] fixture mínimo (identity.tenants/users, hr.employees, current_tenant_id)');
  await knex.raw(`DO $$ BEGIN CREATE ROLE app_runtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await knex.raw(FIXTURE);

  console.log('\n[1] la migración de ayer crea la tabla tal como está en prod');
  await correr(knex, ne04.up);
  let f = await foto(knex);
  assert(f.cols.includes('employee_id'), 'nace con employee_id');
  assert(/REFERENCES hr\.employees\(id\)/.test(f.cons.person_aliases_employee_fk || ''),
    'el FK apunta a hr.employees (el defecto que se corrige)', f.cons.person_aliases_employee_fk);

  console.log('\n[2] [NE.0.13] up — posconditions leídas del catálogo');
  await correr(knex, ne013.up);
  f = await foto(knex);
  assert(f.cols.includes('user_id'), 'la columna ahora es user_id');
  assert(!f.cols.includes('employee_id'), 'employee_id ya no existe');
  assert(!f.cons.person_aliases_employee_fk, 'el FK viejo se fue');
  // ⚠️ NO se compara el texto de pg_get_constraintdef: omite el esquema cuando la tabla está en el
  //    search_path, así que diría lo mismo apuntando a otra tabla llamada `users`.
  const { rows: [fk] } = await knex.raw(
    `SELECT c.confrelid = 'identity.users'::regclass AS apunta_a_identity_users,
            (SELECT array_agg(a.attname::text ORDER BY x.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum) AS origen,
            (SELECT array_agg(a.attname::text ORDER BY x.ord)
               FROM unnest(c.confkey) WITH ORDINALITY AS x(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = x.attnum) AS destino,
            c.confdeltype
       FROM pg_constraint c
      WHERE c.conrelid = 'hr.person_aliases'::regclass AND c.conname = 'person_aliases_user_fk'`,
  );
  assert(
    !!fk && fk.apunta_a_identity_users === true &&
      String(fk.origen) === 'tenant_id,user_id' &&
      String(fk.destino) === 'tenant_id,id' && fk.confdeltype === 'r',
    'el FK nuevo es (tenant_id,user_id) -> identity.users(tenant_id,id) ON DELETE RESTRICT',
    JSON.stringify(fk),
  );
  assert(f.idx.includes('ix_person_aliases_usuario'), 'índice nuevo presente');
  assert(!f.idx.includes('ix_person_aliases_empleado'), 'índice viejo retirado');
  // Lo que NO debía tocarse — es lo que impide que un empate por nombre se vuelva verdad en silencio:
  assert(!!f.cons.person_aliases_matched_by_ck, 'matched_by sigue acotado');
  assert(!!f.cons.person_aliases_nombre_ck, 'sigue el CHECK de que un empate por nombre lleve nota');
  assert(!!f.cons.person_aliases_system_ck, 'sigue el CHECK de system');
  assert(!!f.cons.person_aliases_code_ck, 'sigue el CHECK de external_code no vacío');
  assert(f.idx.includes('ux_person_aliases_externo'), 'sigue el único por (system, external_code)');
  assert(f.rls.encendida === true && f.rls.forzada === true, 'RLS sigue encendida y forzada');
  assert(f.pol.includes('person_aliases_tenant'), 'la política de tenant sigue');
  const { rows: [g] } = await knex.raw(
    `SELECT has_table_privilege('app_runtime','hr.person_aliases','INSERT') AS ins,
            has_table_privilege('app_runtime','hr.person_aliases','SELECT') AS sel`,
  );
  assert(g.ins === true && g.sel === true, 'app_runtime conserva sus permisos');
  const { rows: [c] } = await knex.raw(
    `SELECT col_description('hr.person_aliases'::regclass,
              (SELECT attnum FROM pg_attribute
                WHERE attrelid='hr.person_aliases'::regclass AND attname='user_id')) AS d`,
  );
  assert(!!c.d && /identity\.users/.test(c.d), 'el COMMENT de la columna quedó escrito');

  console.log('\n[3] idempotencia: up dos veces');
  await correr(knex, ne013.up);
  f = await foto(knex);
  assert(f.cols.includes('user_id') && !!f.cons.person_aliases_user_fk, 'la segunda corrida no hace nada');

  console.log('\n[4] negativas FUNCIONALES (lo que un ensayo en seco no puede dar)');
  await knex.raw(
    `INSERT INTO hr.person_aliases (tenant_id, user_id, system, external_code, matched_by)
       VALUES (?, ?, 'nomina', '0001', 'llave')`, [T_MD, U_MD],
  );
  assert(true, 'control positivo: un alias legítimo SÍ entra');
  let e = await debeFallar(knex, (trx) => trx.raw(
    `INSERT INTO hr.person_aliases (tenant_id, user_id, system, external_code, matched_by)
       VALUES (?, ?, 'nomina', '0002', 'llave')`, [T_MD, U_OTRO],
  ));
  assert(e && e.code === '23503', 'un alias que nombra a alguien de OTRO tenant es RECHAZADO', e && e.code);
  e = await debeFallar(knex, (trx) => trx.raw(
    `INSERT INTO hr.person_aliases (tenant_id, user_id, system, external_code, matched_by)
       VALUES (?, ?, 'reloj', '0003', 'nombre')`, [T_MD, U_MD],
  ));
  assert(e && e.code === '23514', 'un empate por nombre SIN nota es rechazado', e && e.code);

  console.log('\n[5] down con filas: debe PARAR');
  e = await debeFallar(knex, ne013.down);
  assert(e && /tiene 1 fila/.test(e.message), 'down se niega mientras haya filas', e && e.message);
  f = await foto(knex);
  assert(f.cols.includes('user_id'), 'y no dejó la tabla a medias');

  console.log('\n[6] down limpio');
  await knex.raw(`DELETE FROM hr.person_aliases`);
  await correr(knex, ne013.down);
  f = await foto(knex);
  assert(f.cols.includes('employee_id') && !f.cols.includes('user_id'), 'la columna volvió a employee_id');
  assert(/REFERENCES hr\.employees\(id\)/.test(f.cons.person_aliases_employee_fk || ''),
    'el FK viejo volvió exactamente igual', f.cons.person_aliases_employee_fk);
  assert(f.idx.includes('ix_person_aliases_empleado') && !f.idx.includes('ix_person_aliases_usuario'),
    'los índices volvieron a su lugar');

  console.log('\n[7] up con filas: debe PARAR');
  const emp = (await knex.raw(`INSERT INTO hr.employees (tenant_id) VALUES (?) RETURNING id`, [T_MD])).rows[0].id;
  await knex.raw(
    `INSERT INTO hr.person_aliases (tenant_id, employee_id, system, external_code, matched_by)
       VALUES (?, ?, 'nomina', '0009', 'llave')`, [T_MD, emp],
  );
  e = await debeFallar(knex, ne013.up);
  assert(e && /tiene 1 fila/.test(e.message), 'up se niega en vez de adivinar a quién apuntaba', e && e.message);
  f = await foto(knex);
  assert(f.cols.includes('employee_id'), 'y la tabla quedó intacta (la transacción revirtió)');
}

(async () => {
  const url = process.env.ENSAYO_URL;
  if (!url) {
    noMedido('sin ENSAYO_URL (hace falta un clúster desechable; ver el encabezado de este archivo)');
    console.log(`\n${ok} ✔ · ${fail} ✖\n`);
    process.exit(0);
  }
  assertSafeTarget('test-newdb-ne013-alias-user-id', { url });

  // Se crea su propia base: así no toca NADA de la base a la que lo apuntaron.
  const base = `ensayo_ne013_${Date.now()}`;
  const admin = Knex({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  let knex = null;
  try {
    await admin.raw(`CREATE DATABASE ${base}`);
    const propia = new URL(url);
    propia.pathname = `/${base}`;
    knex = Knex({ client: 'pg', connection: propia.toString(), pool: { min: 0, max: 2 } });
    await ensayo(knex);
  } catch (e) {
    fail++;
    console.log(`  ✖ el ensayo explotó: ${e.message}`);
  } finally {
    if (knex) await knex.destroy();
    try {
      await admin.raw(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`);
    } catch (e) {
      console.log(`  (no se pudo borrar la base desechable ${base}: ${e.message})`);
    }
    await admin.destroy();
  }

  console.log(`\n${ok} ✔ · ${fail} ✖\n`);
  process.exit(fail ? 1 : 0);
})();
