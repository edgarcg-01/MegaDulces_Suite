'use strict';
/**
 * `[OPS]` — **`dev_ro` recupera la lectura de `servicedesk` y `devtools`.**
 *
 * ── El sintoma ──────────────────────────────────────────────────────────────────────────────
 *     ERROR [Exception] GET /api/service-desk/me/notifications -> 500:
 *     permission denied for schema servicedesk   (42501)
 *
 * ── Lo que NO era, aunque el mensaje lo sugiera ─────────────────────────────────────────────
 * ⛔ No falta el `GRANT USAGE`. La migracion `20261002100000` lo hace, y hasta lleva el
 * comentario *"Sin USAGE del schema los GRANT de tabla no sirven: el runtime tira 42501. Ya paso
 * con budget"*. Las 9 migraciones de `servicedesk` estan aplicadas (batches 687-775) y el schema
 * existe con sus 13 tablas.
 *
 * ⛔ Tampoco esta roto en produccion: `app_runtime` **si** tiene USAGE, y es el rol con el que
 * corre el API de prod (medido: 6 conexiones vivas con ese rol).
 *
 * ── Lo que era ──────────────────────────────────────────────────────────────────────────────
 * El equipo desarrolla **en local contra la base de prod, con roles de solo lectura**. Esos
 * roles entran por **`dev_ro`**, y a `servicedesk` se le dio USAGE a `app_runtime` y **no a
 * `dev_ro`**. O sea: el schema nacio invisible para todo el equipo.
 *
 * ── La convencion, medida antes de escribirla ───────────────────────────────────────────────
 * No se invento nada: se copio lo que hacen los otros 20 schemas. Cada uno lleva CUATRO cosas,
 * y faltar la cuarta es lo que hace que esto se repita:
 *
 *     1. GRANT USAGE ON SCHEMA ... TO dev_ro
 *     2. GRANT SELECT ON ALL TABLES ... TO dev_ro        (las que ya existen)
 *     3. ALTER DEFAULT PRIVILEGES FOR ROLE postgres      (las que cree postgres manana)
 *     4. ALTER DEFAULT PRIVILEGES FOR ROLE app_runtime   (las que cree el runtime manana)
 *
 * Medido en prod: **48** `ALTER DEFAULT PRIVILEGES` configurados, siempre de a dos por schema, y
 * la cobertura de SELECT para `dev_ro` da `analytics` 267/267, `commercial` 155/155,
 * `finance` 65/65 — contra `servicedesk` **0/13** y `devtools` **0/5**.
 *
 * ⭐ **`devtools` entra aunque nadie se haya quejado todavia**: es el mismo defecto encontrado
 * por la misma medicion, y dejarlo afuera garantiza que alguien se coma el mismo 500 la proxima
 * semana. Los dos son los UNICOS dos schemas que `app_runtime` ve y `dev_ro` no.
 *
 * ⚠️ Estrictamente **SELECT**. `dev_ro` es un rol de lectura y esta migracion no lo cambia: ni
 * INSERT, ni secuencias, ni funciones. Un rol de lectura que escribe deja de ser lo que dice su
 * nombre, y el acuerdo de "local contra prod" se apoya justo en ese nombre.
 *
 * ⚠️ Corre como `postgres` (el dueño de los dos schemas). `ALTER DEFAULT PRIVILEGES FOR ROLE
 * app_runtime` solo lo puede hacer ese rol o un superusuario.
 *
 * Idempotente: `GRANT` y `ALTER DEFAULT PRIVILEGES` son declarativos — re-aplicarlos no suma
 * nada. El `DO` salta el schema que no exista, para que esto no reviente en un destino donde
 * Mesa de Servicio todavia no se instalo.
 *
 * @param { import("knex").Knex } knex
 */

const SCHEMAS = ['servicedesk', 'devtools'];

exports.up = async function up(knex) {
  for (const s of SCHEMAS) {
    const { rows: [ns] } = await knex.raw(
      `SELECT count(*)::int n FROM pg_namespace WHERE nspname = ?`, [s]);
    if (!ns.n) {
      console.log(`[dev_ro_grants] schema "${s}" no existe en este destino: se salta`);
      continue;
    }
    await knex.raw(`GRANT USAGE ON SCHEMA ${s} TO dev_ro`);
    await knex.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO dev_ro`);
    await knex.raw(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres    IN SCHEMA ${s} GRANT SELECT ON TABLES TO dev_ro`);
    await knex.raw(`ALTER DEFAULT PRIVILEGES FOR ROLE app_runtime IN SCHEMA ${s} GRANT SELECT ON TABLES TO dev_ro`);

    const { rows: [cob] } = await knex.raw(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE has_table_privilege('dev_ro', c.oid, 'SELECT'))::int leibles
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ? AND c.relkind IN ('r','v','m','p')`, [s]);
    console.log(`[dev_ro_grants] ${s}: dev_ro lee ${cob.leibles} de ${cob.total} objetos`);
    // Si el GRANT no alcanzo a todo, es mejor saberlo aca que en un 500 de alguien.
    if (cob.leibles !== cob.total) {
      throw new Error(`${s}: dev_ro quedo con ${cob.leibles}/${cob.total} — el GRANT no cubrio todo`);
    }
  }
};

exports.down = async function down(knex) {
  for (const s of SCHEMAS) {
    const { rows: [ns] } = await knex.raw(
      `SELECT count(*)::int n FROM pg_namespace WHERE nspname = ?`, [s]);
    if (!ns.n) continue;
    await knex.raw(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres    IN SCHEMA ${s} REVOKE SELECT ON TABLES FROM dev_ro`);
    await knex.raw(`ALTER DEFAULT PRIVILEGES FOR ROLE app_runtime IN SCHEMA ${s} REVOKE SELECT ON TABLES FROM dev_ro`);
    await knex.raw(`REVOKE SELECT ON ALL TABLES IN SCHEMA ${s} FROM dev_ro`);
    await knex.raw(`REVOKE USAGE ON SCHEMA ${s} FROM dev_ro`);
  }
};
