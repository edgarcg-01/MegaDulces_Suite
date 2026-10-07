/**
 * Fase L.8 — Cleanup: drop schemas `field_ops` y `scoring`.
 *
 * Estos 2 schemas se crearon en la migración `20260603130000` como un intento
 * previo de namespacing — contenían VIEWs read-only apuntando a `public.*`.
 * En L.2 (`20260604110000`) movimos las tablas reales a `trade.*` y dropeamos
 * esas VIEWs, dejando ambos schemas VACÍOS.
 *
 * Ahora los eliminamos completamente:
 *   1. Update search_path de roles `app_runtime` y `postgres` para sacarlos.
 *   2. DROP SCHEMA field_ops, scoring.
 *
 * Verificación pre-drop (correr antes en cada DB):
 *   SELECT n.nspname, COUNT(c.relname)
 *     FROM pg_namespace n
 *     LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','v','m','f','S')
 *    WHERE n.nspname IN ('field_ops','scoring') GROUP BY n.nspname;
 * → Ambos deben dar COUNT = 0 antes de aplicar.
 *
 * ADR-015 — Schema reorg.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1. Search_path sin field_ops ni scoring
  await knex.raw(`
    ALTER ROLE app_runtime SET search_path = identity, catalog, trade, commercial, logistics, public
  `);
  await knex.raw(`
    ALTER ROLE postgres SET search_path = identity, catalog, trade, commercial, logistics, public, "$user"
  `);

  // 2. DROP SCHEMA RESTRICT (falla si tiene objetos — defensa contra ejecución
  // accidental sobre una DB donde alguien metió tablas nuevas en estos schemas)
  const checkEmpty = async (schema) => {
    const r = await knex.raw(
      `SELECT COUNT(*)::int AS c FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=? AND c.relkind IN ('r','v','m','f','S')`,
      [schema],
    );
    if (r.rows[0].c > 0) {
      throw new Error(
        `Schema ${schema} no está vacío (${r.rows[0].c} objetos). Cancelando drop por seguridad.`,
      );
    }
  };
  await checkEmpty('field_ops');
  await checkEmpty('scoring');

  await knex.raw(`DROP SCHEMA IF EXISTS field_ops RESTRICT`);
  await knex.raw(`DROP SCHEMA IF EXISTS scoring RESTRICT`);
  console.log('  ✓ Dropped legacy schemas: field_ops, scoring');
};

/**
 * Rollback: recrear schemas vacíos + restore search_path.
 *
 * Note: NO restaura las VIEWs que vivían en field_ops/scoring originalmente
 * (la migración L.2 ya las dropeaba antes de mover las tablas). Si se necesita
 * restaurar el comportamiento previo a L.2 hay que correr el `down` de L.2.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS field_ops`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS scoring`);
  await knex.raw(`GRANT USAGE ON SCHEMA field_ops TO app_runtime`);
  await knex.raw(`GRANT USAGE ON SCHEMA scoring TO app_runtime`);
  await knex.raw(`
    ALTER ROLE app_runtime SET search_path = identity, catalog, trade, field_ops, scoring, commercial, logistics, public
  `);
  await knex.raw(`
    ALTER ROLE postgres SET search_path = identity, catalog, trade, field_ops, scoring, commercial, logistics, public, "$user"
  `);
};
